import { Token } from "../lexer";
import { ProgramNode } from "../parser/nodes/base";
import { TypeDeclarationNode, VariableDeclarationNode } from "../parser/nodes/statements";
import { TypeConcreteNode, TypeExpressionNode } from "../parser/nodes/types";
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
  number: create_no_arg_type_constructor("number"),
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
  number: { registry: "number", arity: 0 },
  bool: { registry: "bool", arity: 0 },
  void: { registry: "void", arity: 0 },
  str: { registry: "str", arity: 0 },
  null: { registry: "null", arity: 0 },
  any: { registry: "any", arity: 0 },
  promise: { registry: "promise", arity: 1 },
  Promise: { registry: "promise", arity: 1 },
};

/** The value type of `obj.key` for an `obj`-typed term, or null when absent or not an object. */
export function object_property_type(obj: Term, key: string): Term | null {
  if (!is_compound(obj) || obj.functor !== "obj") return null;

  for (const entry of obj.args) {
    if (is_compound(entry) && entry.functor === key) return entry.args[0];
  }
  return null;
}

/** Mints fresh type variables (`t0`, `t1`, ...) for one typecheck pass. Each
 *  pass owns its generator, so concurrent passes mint independently. */
export class FreshVarGenerator {
  private counter = 0;

  /** The next unused variable. */
  next(): Var {
    return variable(`t${this.counter++}`);
  }

  /** Current counter value; snapshot it before an infer to scope `generalize` to that infer. */
  value(): number {
    return this.counter;
  }
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

/** The resolved form of a type name, whether it names a type alias or a
 *  built-in: a complete type, a built-in parametric name that still awaits
 *  its type arguments at the use site, or a user-defined type constructor
 *  whose body was lowered with its type parameters bound to fresh variables
 *  (`param_vars`, one per `params`) and awaits its type arguments at the use
 *  site. */
export type ResolvedType =
  | { kind: "complete"; term: Term }
  | { kind: "parametric"; registry: string; arity: number }
  | { kind: "user_parametric"; params: string[]; param_vars: string[]; body: Term };

type AliasEntry = {
  name: string;
  /** The declaration's name token; null for a type-parameter binding. */
  name_token: Token | null;
  /** The declared type parameters; null for plain aliases and parameter bindings. */
  params: string[] | null;
  /** The target type expression; null for a type-parameter binding (whose record is pre-computed). */
  target: TypeExpressionNode | null;
  record: ResolvedType | null;
  computing: boolean;
};

/** Block-scoped type alias table for one typecheck pass. Aliases are scoped
 *  per block like value bindings, but they live in the type namespace: a scope
 *  is pushed for each block, and top-level aliases are pre-registered in the
 *  outermost scope at the start of the pass. The owning context is kept so a
 *  non-bare-name target (`type P = Promise<number>:`) can be lowered. */
export class AliasTable {
  private scopes: Array<Map<string, AliasEntry>> = [new Map()];

  constructor(private readonly ctx: TypecheckContext) {}

  push_scope(): void {
    this.scopes.push(new Map());
  }

  pop_scope(): void {
    const scope = this.scopes.pop();
    if (scope === undefined) throw new Error("Popped more type alias scopes than were pushed");
  }

  /** Register a new alias in the innermost scope. The name must not be a
   *  built-in type name and must not already be bound in the same scope
   *  (shadowing outer scopes is allowed, mirroring lets). When `params` is
   *  given the alias is a user-defined type constructor: the parameter names
   *  must not duplicate each other or a built-in type name. */
  declare(name_token: Token, params: Token[] | null, target: TypeExpressionNode): void {
    const name = name_token.lexeme;
    if (type_names[name] !== undefined)
      throw new TypeCheckError(`Cannot define a type alias for the built-in type name "${name}"`, name_token);

    // Check that type param name won't shadow intrinsic types and
    const seen = new Set<string>();
    if (params !== null) {
      for (const param of params) {
        if (type_names[param.lexeme] !== undefined)
          throw new TypeCheckError(
            `Cannot define a type parameter for the built-in type name "${param.lexeme}"`,
            param,
          );

        if (seen.has(param.lexeme)) throw new TypeCheckError(`Duplicate type parameter "${param.lexeme}"`, param);
        seen.add(param.lexeme);
      }
    }

    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) throw new TypeCheckError(`Duplicate type alias "${name}"`, name_token);
    scope.set(name, {
      name,
      name_token,
      params: params?.map((p) => p.lexeme) ?? null,
      target,
      record: null,
      computing: false,
    });
  }

  /** The record of a declared alias; throws a plain error when the name was
   *  never declared (a driver bug, not a type error). */
  record(name: string): ResolvedType {
    const entry = this.find_entry(name);
    if (entry === undefined) throw new Error(`Type alias "${name}" is not declared`);
    return this.compute_record(entry);
  }

  /** Resolve a type name written in an annotation: type aliases first (so an
   *  alias may chain onto other aliases and built-in names), then built-in
   *  type names. Unknown names are a type error. This is the single
   *  resolution path used by every `TypeExpressionNode.lower`, so alias
   *  handling is transparent to the node implementations. */
  resolve(name: string, token?: Token): ResolvedType {
    const entry = this.find_entry(name);
    if (entry !== undefined) return this.compute_record(entry);

    const info = type_names[name];
    if (info === undefined) throw new TypeCheckError(`Unknown type name: "${name}"`, token);
    return info.arity === 0
      ? { kind: "complete", term: create_type(info.registry) }
      : { kind: "parametric", registry: info.registry, arity: info.arity };
  }

  /** The top-level aliases with their computed records; reported by --debug-types. */
  top_level(): { name: string; name_token: Token; record: ResolvedType }[] {
    const scope = this.scopes[this.scopes.length - 1];
    return [...scope.values()].map((entry) => ({
      name: entry.name,
      // parameter-scope bindings are always popped before a pass ends, so the
      // top-level scope holds only declarations
      name_token: entry.name_token!,
      record: entry.record!,
    }));
  }

  /** Instantiate a user-defined type constructor: substitute the argument
   *  types for its type parameters in the body lowered at declaration. Every
   *  use gets an independent term; the stored body is untouched. */
  apply_user_constructor(name: string, args: Term[]): Term {
    const entry = this.find_entry(name);
    if (entry === undefined) throw new Error(`Type alias "${name}" is not declared`);

    const record = this.compute_record(entry);
    if (record.kind !== "user_parametric") throw new Error(`Type "${name}" is not a type constructor`);

    const subst = new Map<string, Term>();
    for (let i = 0; i < record.param_vars.length; i++) subst.set(record.param_vars[i], args[i]);
    return apply_term(record.body, subst);
  }

  /** Find an alias entry by name, walking the scopes innermost-first. */
  private find_entry(name: string): AliasEntry | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const entry = this.scopes[i].get(name);
      if (entry !== undefined) return entry;
    }
    return undefined;
  }

  /** Compute (and memoize) an alias's record. A re-entrant computation is a
   *  circular alias definition. */
  private compute_record(entry: AliasEntry): ResolvedType {
    if (entry.record !== null) return entry.record;
    if (entry.target === null) throw new Error(`Type "${entry.name}" has no target`);
    if (entry.computing) throw new TypeCheckError(`Circular type alias definition: "${entry.name}"`, entry.name_token!);

    entry.computing = true;
    try {
      entry.record = this.lower_target(entry.target, entry.params);
    } finally {
      entry.computing = false;
    }

    return entry.record;
  }

  /** Lower an alias target to a record. A target with type parameters is a
   *  user-defined type constructor: its body is lowered once, with the
   *  parameters bound to fresh variables, and each use substitutes its type
   *  arguments for those variables. Because the lowering happens inside
   *  `compute_record`, a body that references its own constructor (directly
   *  or through other constructors) is a circular definition. A bare name
   *  goes through the unified resolver (which handles alias chains and
   *  built-in names); any other target node lowers to a complete type. */
  private lower_target(target: TypeExpressionNode, params: string[] | null): ResolvedType {
    if (params !== null) {
      const param_vars: string[] = [];
      this.push_scope();

      try {
        for (const param of params) {
          const v = this.ctx.fresh.next();
          param_vars.push(v.name);
          this.bind_param(param, { kind: "complete", term: v });
        }

        return { kind: "user_parametric", params, param_vars, body: target.lower(this.ctx) };
      } finally {
        this.pop_scope();
      }
    }

    if (target instanceof TypeConcreteNode) {
      const resolved = this.resolve(target.name.lexeme, target.name);
      if (resolved.kind === "user_parametric")
        throw new TypeCheckError(`Type "${target.name.lexeme}" requires a type argument`, target.name);
      return resolved;
    }
    return { kind: "complete", term: target.lower(this.ctx) };
  }

  /** Bind a type parameter name to a pre-computed record in the innermost
   *  scope while lowering a type constructor's body. The names were validated
   *  when the constructor was declared. */
  private bind_param(name: string, record: ResolvedType): void {
    const scope = this.scopes[this.scopes.length - 1];
    scope.set(name, { name, name_token: null, params: null, target: null, record, computing: false });
  }
}

/** All mutable state of one typecheck pass, instantiated at the root and
 *  threaded through the checker as a single `ctx` parameter, so multiple
 *  passes (separate programs, nested passes) run independently. */
export class TypecheckContext {
  readonly fresh: FreshVarGenerator;
  readonly aliases: AliasTable;

  constructor() {
    this.fresh = new FreshVarGenerator();
    this.aliases = new AliasTable(this);
  }
}

/** Unify two types, throwing a TypeCheckError with both rendered types on failure. */
export function unify_check(actual: Term, expected: Term, sub: Substitution, message?: string, token?: Token): void {
  if (!unify_write(actual, expected, sub)) {
    throw new TypeCheckError(
      `${message ?? "Type mismatch"}: got ${show_type(resolve(actual, sub.map))}, expected ${show_type(
        resolve(expected, sub.map),
      )}`,
      token,
    );
  }
}

/**
 * The static signature of a builtin function. Parameters of type `any`
 * accept an argument of any type; a variadic signature applies `params[0]`
 * to every argument.
 */
export interface IntrinsicSignature {
  params: Term[];
  variadic: boolean;
  return: Term;
}

export const intrinsics: Map<string, IntrinsicSignature> = new Map([
  ["print", { params: [create_type("any")], variadic: true, return: create_type("bool") }],
  [
    "resolve",
    { params: [create_type("any")], variadic: true, return: create_type("promise", [create_type("number")]) },
  ],
]);

/** Check a call to a builtin against its signature, throwing on violation. */
export function check_intrinsic_call(
  name: string,
  sig: IntrinsicSignature,
  arg_types: Term[],
  sub: Substitution,
  token?: Token,
): void {
  if (sig.variadic === false && arg_types.length !== sig.params.length)
    throw new TypeCheckError(
      `Builtin ${name} expects ${sig.params.length} argument(s), got ${arg_types.length}`,
      token,
    );

  for (let i = 0; i < arg_types.length; i++) {
    const param = resolve(sig.variadic ? sig.params[0] : sig.params[i], sub.map);
    if (param.kind === "atom" && param.name === "any") continue;
    unify_check(arg_types[i], param, sub, `Argument ${i + 1} of ${name}`);
  }
}

export type PolyType = { vars: string[]; type: Term };
/** `mutable` marks user-declared values that can be reassigned (`let`
 *  declarations and function parameters); assignment to an immutable binding
 *  is a type error.
 *  `builtin` marks the global `print`/`resolve` entries so call sites can tell
 *  them apart from user declarations that shadow the same name.
 *  `placeholder` names the variable a pre-registered declaration was registered
 *  under; the declaration commits its inferred type to that variable when it is
 *  processed, and `generalize` keeps variables of other placeholders' classes
 *  undeclared so their constraints survive. */
export type Binding = { poly: PolyType; mutable: boolean; builtin?: boolean; placeholder?: string };
export type BindingOptions = { mutable?: boolean; builtin?: boolean; placeholder?: string };
export const create_binding = (
  poly: PolyType,
  { mutable = false, builtin = false, placeholder }: BindingOptions = {},
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
export function generalize(
  t: Term,
  e: TypeEnvironment,
  sub: Substitution,
  from: number,
  ctx: TypecheckContext,
  self?: string,
): PolyType {
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
    if (index >= from && index < ctx.fresh.value()) {
      declare(resolved);
      return resolved;
    }

    if (is_shared(resolved)) return resolved;

    let replacement = replacements.get(resolved.name);
    if (replacement === undefined) {
      replacement = ctx.fresh.next();
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
export function instantiate_binding(binding: Binding, sub: Substitution, ctx: TypecheckContext): Term {
  for (const v of binding.poly.vars) sub.bind(v, ctx.fresh.next());
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

/** The global bindings for the builtins, derived from the `intrinsics`
 *  signatures so the two never drift apart: a variadic builtin's `f`-type is
 *  `f(params[0], return)`. */
const globals = Object.fromEntries(
  [...intrinsics.entries()].map(([name, sig]) => [
    name,
    create_binding(
      { vars: [], type: create_type("f", [...(sig.variadic ? [sig.params[0]] : sig.params), sig.return]) },
      { builtin: true },
    ),
  ]),
) as { [key: string]: Binding };

/** Typecheck a program; returns the final top-level environment (every declaration
 *  with its committed polytype), the accumulated substitution, and the pass's
 *  context (alias table and fresh variable generator), for debugging. */
export function typecheck(program: ProgramNode): { env: TypeEnvironment; sub: Substitution; ctx: TypecheckContext } {
  const ctx = new TypecheckContext();

  const substitution = new Substitution();
  const environment = new Map<string, Binding>(Object.entries(globals));
  const all_environment: TypeEnvironment = new Map(environment);

  // Pre-register the top-level type aliases in the outermost alias scope so
  // they can be referenced from anywhere in the program, including function
  // bodies that appear before the declaration (mirroring the let pre-scan).
  // Two passes: all names are declared first, then all records are computed,
  // so top-level aliases may reference each other in any order.
  for (const stmt of program.statements.get_items())
    if (stmt instanceof TypeDeclarationNode)
      ctx.aliases.declare(stmt.name, stmt.params?.get_items() ?? null, stmt.type);

  for (const stmt of program.statements.get_items())
    if (stmt instanceof TypeDeclarationNode) stmt.registered = ctx.aliases.record(stmt.name.lexeme);

  // Pre-register the top-level declarations in all_environment so that function
  // bodies can reference declarations that come after them (a closure sees the
  // live scope at call time, so this mirrors the runtime). Annotated
  // declarations register their annotation; unannotated ones register a fresh
  // placeholder variable, which the declaration commits to its inferred type
  // when it is processed. Duplicate names are not pre-registered: the later let
  // overwrites the earlier one, exactly like the live environment.
  for (const stmt of program.statements.get_items()) {
    if (!(stmt instanceof VariableDeclarationNode)) continue;
    if (stmt.type !== null) {
      stmt.registered = create_binding({ vars: [], type: stmt.type.lower(ctx) }, { mutable: true });
    } else {
      const placeholder = ctx.fresh.next();
      stmt.registered = create_binding(
        { vars: [], type: placeholder },
        { mutable: true, placeholder: placeholder.name },
      );
    }
    all_environment.set(stmt.variable_name.lexeme, stmt.registered);
  }

  let threaded_env = environment;
  const r = create_type("void");
  for (const stmt of program.statements.get_items())
    threaded_env = stmt.typecheck({ e: threaded_env, e_all: all_environment, sub: substitution, r, ctx });
  return { env: threaded_env, sub: substitution, ctx };
}
