import { Token } from "../lexer";
import { ProgramNode } from "../parser/nodes/base";
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

/** Build a type from a registered name and its type arguments; unknown names are a bug. */
export function create_type(name: keyof typeof type_constructors, args: Term[] = []): Term {
  const ctor = type_constructors[name];
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
export function check_unify(actual: Term, expected: Term, sub: Substitution, message?: string): void {
  if (!unify_write(actual, expected, sub)) {
    throw new TypeCheckError(
      `${message ?? "Type mismatch"}: got ${show_type(resolve(actual, sub.map))}, expected ${show_type(
        resolve(expected, sub.map),
      )}`,
    );
  }
}

export type PolyType = { vars: string[]; type: Term };
/** `builtin` marks the global `print`/`resolve` entries so call sites can tell
 *  them apart from user declarations that shadow the same name. */
export type Binding = { poly: PolyType; mutable: boolean; builtin?: boolean };
export const create_binding = (poly: PolyType, mutable = false, builtin = false): Binding => ({
  poly,
  mutable,
  builtin,
});

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
 * declared. Returns the polytype with the stored (frozen) type.
 */
export function generalize(t: Term, e: TypeEnvironment, sub: Substitution, from: number): PolyType {
  // get the variables inside
  const env_free = env_free_vars(e);

  const replacements = new Map<string, Term>();
  const vars: string[] = [];
  const declared = new Set<string>();

  const declare = (v: Var): void => {
    if (!declared.has(v.name) && !env_free.has(v.name)) {
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

const globals = {
  print: create_binding({ vars: [], type: create_type("f", [create_type("any"), create_type("bool")]) }, false, true),
  resolve: create_binding(
    { vars: [], type: create_type("f", [create_type("any"), create_type("promise", [create_type("int")])]) },
    false,
    true,
  ),
} as { [key: string]: Binding };

export function typecheck(program: ProgramNode): void {
  reset_fresh_vars();

  const substitution = new Substitution();
  let environment = new Map<string, Binding>(Object.entries(globals));

  for (const stmt of program.statements.get_items()) {
    const r = create_type("void");
    environment = stmt.typecheck(environment, substitution, r);
  }
}
