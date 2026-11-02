import { Token } from "../lexer";
import { ProgramNode } from "../parser/nodes/base";
import { VariableDeclarationNode } from "../parser/nodes/statements";
import { atom, compound, is_compound, show_type, Term, Var, variable } from "./ast";
import { apply_term, resolve, Substitution, unify_write } from "./unify";

/** Zero-argument type constructors reject type arguments; silently ignoring them would hide mistakes. */
const create_no_arg_type_constructor =
  (name: string): ((args: Term[]) => Term) =>
  (args) => {
    if (args.length > 0) throw new Error(`Type "${name}" takes no type arguments`);
    return atom(name);
  };

const type_constructors = {
  int: create_no_arg_type_constructor("int"),
  bool: create_no_arg_type_constructor("bool"),
  void: create_no_arg_type_constructor("void"),
  str: create_no_arg_type_constructor("str"),
  null: create_no_arg_type_constructor("null"),
  any: create_no_arg_type_constructor("any"),
  /** `f(p1, ..., pn, R)`: all but the last argument are parameters, the last is the return type. */
  f: (args) => compound("f", args),
  array: (args) => compound("array", args),
  obj: (args) => compound("obj", args),
  promise: (args) => compound("promise", args),
} satisfies Record<string, (args: Term[]) => Term>;

/** Build a type from a registered name and its type arguments; unknown names throw. */
export function create_type(name: string, args: Term[] = []): Term {
  const ctor = (type_constructors as Record<string, (args: Term[]) => Term>)[name];
  if (ctor === undefined) throw new Error(`Unknown type: "${name}"`);
  return ctor(args);
}

/** Surface type names accepted in annotations, mapped to their registry name.
 *  `arity` is the exact number of type arguments the name takes. */
type TypeNameInfo = { registry: keyof typeof type_constructors; arity: number };

const type_names: Record<string, TypeNameInfo> = {
  int: { registry: "int", arity: 0 },
  bool: { registry: "bool", arity: 0 },
  void: { registry: "void", arity: 0 },
  str: { registry: "str", arity: 0 },
  null: { registry: "null", arity: 0 },
  any: { registry: "any", arity: 0 },
  promise: { registry: "promise", arity: 1 },
  Promise: { registry: "promise", arity: 1 },
};

/** Resolve a type name written in an annotation; unknown names are a type error. */
export function resolve_type_name(name: string, token?: Token): TypeNameInfo {
  const info = type_names[name];
  if (info !== undefined) return info;
  throw new TypeCheckError(`Unknown type name: "${name}"`, token);
}

/** The value type of `obj.key` for an `obj`-typed term, or null when absent or not an object. */
export function object_property_type(obj: Term, key: string): Term | null {
  if (!is_compound(obj) || obj.functor !== "obj") return null;

  for (const entry of obj.args) {
    if (is_compound(entry) && entry.functor === key) return entry.args[0];
  }
  return null;
}

/** Mint fresh type variables with unique names; reset at the start of each typecheck pass. */
let fresh_counter = 0;
export function fresh_var(): Var {
  return variable(`t${fresh_counter++}`);
}
export function reset_fresh_vars(): void {
  fresh_counter = 0;
}
/** Current counter value; snapshot it before an infer to scope `generalize` to that infer. */
export function get_fresh_counter_value(): number {
  return fresh_counter;
}

export class TypeCheckError extends Error {
  constructor(
    message: string,
    public readonly token?: Token,
  ) {
    super(message);
    this.name = "TypeCheckError";
  }
}

/** Unify two types, throwing a TypeCheckError with both rendered types on failure. */
export function check_unify(
  actual: Term,
  expected: Term,
  sub: Substitution,
  message?: string,
  token?: Token,
): void {
  if (!unify_write(actual, expected, sub)) {
    throw new TypeCheckError(
      `${message ?? "Type mismatch"}: got ${show_type(resolve(actual, sub.map))}, expected ${show_type(
        resolve(expected, sub.map),
      )}`,
      token,
    );
  }
}

export type PolyType = { vars: string[]; type: Term };
/** `builtin` marks the global `print`/`resolve` entries so call sites can tell
 *  them apart from user declarations that shadow the same name.
 *  `placeholder` names the variable a pre-registered declaration was registered
 *  under; the declaration commits its inferred type to that variable when it is
 *  processed, and `generalize` keeps variables of other placeholders' classes
 *  undeclared so their constraints survive. */
export type Binding = { poly: PolyType; mutable: boolean; builtin?: boolean; placeholder?: string };
export const create_binding = (
  poly: PolyType,
  mutable = false,
  builtin = false,
  placeholder?: string,
): Binding => ({ poly, mutable, builtin, placeholder });

export type TypeEnvironment = Map<string, Binding>;

/** Syntactic names of the type variables occurring in `t` (no resolution). */
export function term_vars(t: Term): Set<string> {
  const out = new Set<string>();
  const visit = (term: Term): void => {
    if (term.kind === "var") out.add(term.name);
    else if (term.kind === "compound") for (const a of term.args) visit(a);
  };

  visit(t);
  return out;
}

/** Free type variables of the environment: variables occurring in a binding's stored type
 *  that the binding does not itself declare. Computed syntactically (without resolution),
 *  so a binding's declared variables never leak into the environment's free variables. */
export function env_free_vars(e: TypeEnvironment): Set<string> {
  const out = new Set<string>();

  for (const binding of e.values()) {
    const declared = new Set(binding.poly.vars);
    for (const v of term_vars(binding.poly.type)) {
      if (!declared.has(v)) out.add(v);
    }
  }

  return out;
}

/**
 * Generalize a type at a binding site (let or assignment). A variable that is still
 * unbound and was minted during the enclosing infer (counter range `[from, now)`)
 * becomes a declared variable of the polytype, so each read re-instantiates it. A
 * variable that resolved to an older, out-of-range unbound variable -- an alias
 * created when the assigned value was checked against the declared instance -- is
 * replaced by a fresh declared variable so the new polytype still re-instantiates
 * independently on each read. Variables already free in the environment are never
 * declared. Variables linked to another binding's committed placeholder shape are
 * kept as-is and never declared: that binding will be constrained when it is
 * processed, and declaring the variable here would let `instantiate_binding`
 * overwrite the constraint on each read. Returns the polytype with the stored
 * (frozen) type.
 */
export function generalize(t: Term, e: TypeEnvironment, sub: Substitution, from: number, self?: string): PolyType {
  // get the variables inside
  const env_free = env_free_vars(e);

  // Root variables of the classes shared with other bindings' placeholder shapes.
  // Comparison is by resolved root so aliases of a shape variable are covered too.
  // Only unprocessed bindings count: their commit will still add constraints to
  // their class; a processed binding's polytype is final, and reads of it
  // re-bind its placeholder to per-read instances, which must not poison the
  // sharing decision.
  const shared_roots = new Set<string>();
  for (const binding of e.values()) {
    const placeholder = binding.placeholder;
    if (placeholder === undefined || placeholder === self) continue;
    const stored = binding.poly.type;
    if (stored.kind !== "var" || stored.name !== placeholder) continue;
    for (const v of term_vars(resolve(variable(placeholder), sub.map))) {
      const root = resolve(variable(v), sub.map);
      if (root.kind === "var") shared_roots.add(root.name);
    }
  }

  const replacements = new Map<string, Term>();
  const vars: string[] = [];
  const declared = new Set<string>();

  const is_shared = (v: Var): boolean => {
    const root = resolve(v, sub.map);
    return root.kind === "var" && shared_roots.has(root.name);
  };

  const declare = (v: Var): void => {
    if (!declared.has(v.name) && !env_free.has(v.name) && !is_shared(v)) {
      declared.add(v.name);
      vars.push(v.name);
    }
  };

  const freeze = (term: Term): Term => {
    const resolved = resolve(term, sub.map);
    if (resolved.kind === "atom") return resolved;
    if (resolved.kind === "compound") return compound(resolved.functor, resolved.args.map(freeze));

    const index = Number(resolved.name.slice(1));
    if (index >= from && index < fresh_counter) {
      declare(resolved);
      return resolved;
    }

    if (is_shared(resolved)) return resolved;

    let replacement = replacements.get(resolved.name);
    if (replacement === undefined) {
      replacement = fresh_var();
      replacements.set(resolved.name, replacement);
      declare(replacement);
    }
    return replacement;
  };

  const type = freeze(t);
  vars.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return { vars, type };
}

/** Instantiate a binding's polytype: a fresh variable for each declared var, then apply
 *  the substitution. Every read of a polymorphic binding gets an independent instance. */
export function instantiate_binding(binding: Binding, sub: Substitution): Term {
  for (const v of binding.poly.vars) sub.bind(v, fresh_var());
  return apply_term(binding.poly.type, sub.fork());
}

/** Render a polytype for debugging: the body via `show_type`, prefixed with a
 *  `forall` over the declared variables. When a substitution is given, the body is
 *  resolved through it first so placeholder classes constrained later (e.g. by a
 *  forward-referenced declaration committing its type) show their final shape.
 *  The polytype's own declared variables are excluded from the snapshot: reads of
 *  the binding instantiate them in the shared substitution, but they must still
 *  display as the polytype's bound names. */
export function show_polytype(poly: PolyType, sub?: Substitution): string {
  const declared = new Set(poly.vars);
  const t =
    sub === undefined
      ? poly.type
      : apply_term(poly.type, new Map([...sub.map].filter(([name]) => !declared.has(name))));
  const body = show_type(t);
  return poly.vars.length === 0 ? body : `forall ${poly.vars.join(", ")}. ${body}`;
}

const globals = {
  print: create_binding({ vars: [], type: create_type("f", [create_type("any"), create_type("bool")]) }, false, true),
  resolve: create_binding(
    { vars: [], type: create_type("f", [create_type("any"), create_type("promise", [create_type("int")])]) },
    false,
    true,
  ),
} as { [key: string]: Binding };

/** Typecheck a program; returns the final top-level environment (every declaration
 *  with its committed polytype) and the accumulated substitution, for debugging. */
export function typecheck(program: ProgramNode): { env: TypeEnvironment; sub: Substitution } {
  reset_fresh_vars();

  const substitution = new Substitution();
  const environment = new Map<string, Binding>(Object.entries(globals));
  const all_environment: TypeEnvironment = new Map(environment);

  // Pre-register the top-level declarations in all_environment so that function
  // bodies can reference declarations that come after them (a closure sees the
  // live scope at call time, so this mirrors the runtime). Annotated
  // declarations register their annotation; unannotated ones register a fresh
  // placeholder variable, which the declaration commits to its inferred type
  // when it is processed. Duplicate names are not pre-registered: the later let
  // overwrites the earlier one, exactly like the live environment.
  const name_counts = new Map<string, number>();
  for (const stmt of program.statements.get_items()) {
    if (stmt instanceof VariableDeclarationNode) {
      const name = stmt.variable_name.lexeme;
      name_counts.set(name, (name_counts.get(name) ?? 0) + 1);
    }
  }
  for (const stmt of program.statements.get_items()) {
    if (!(stmt instanceof VariableDeclarationNode)) continue;
    if (name_counts.get(stmt.variable_name.lexeme) !== 1) continue;
    if (stmt.type !== null) {
      stmt.registered = create_binding({ vars: [], type: stmt.type.lower() }, true);
    } else {
      const placeholder = fresh_var();
      stmt.registered = create_binding({ vars: [], type: placeholder }, true, false, placeholder.name);
    }
    all_environment.set(stmt.variable_name.lexeme, stmt.registered);
  }

  let environment2 = environment;
  for (const stmt of program.statements.get_items()) {
    const r = create_type("void");
    environment2 = stmt.typecheck(environment2, all_environment, substitution, r);
  }
  return { env: environment2, sub: substitution };
}
