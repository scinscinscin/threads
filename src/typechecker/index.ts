import { Token } from "../lexer";
import { ProgramNode } from "../parser/nodes/base";
import { atom, compound, is_compound, show_type, Term, variable } from "./ast";
import { resolve, Substitution, unify_write } from "./unify";

export const create_function_type = (a: Term, b: Term): Term => compound("f", [a, b]);
/** A function type from its parameter types and return type: `f(p1, ..., pn, R)`. */
export const create_function_type_n = (params: Term[], ret: Term): Term => compound("f", [...params, ret]);
export const create_int_type = (): Term => atom("int");
export const create_boolean_type = (): Term => atom("bool");
export const create_void_type = (): Term => atom("void");
export const create_string_type = (): Term => atom("str");
export const create_null_type = (): Term => atom("null");
export const create_any_type = (): Term => atom("any");
export const create_array_type = (elem: Term): Term => compound("array", [elem]);
export const create_promise_type = (inner: Term): Term => compound("promise", [inner]);
export const create_object_type = (entries: [string, Term][]): Term =>
  compound(
    "obj",
    entries.map(([key, type]) => compound(key, [type])),
  );

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
export function fresh_var(): Term {
  return variable(`t${fresh_counter++}`);
}
export function reset_fresh_vars(): void {
  fresh_counter = 0;
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
export function typecheck(program: ProgramNode): void {
  reset_fresh_vars();

  const substitution = new Substitution();
  let environment = new Map<string, Binding>([
    [
      "print",
      create_binding({ vars: [], type: create_function_type(create_any_type(), create_boolean_type()) }, false, true),
    ],
    [
      "resolve",
      create_binding(
        { vars: [], type: create_function_type(create_any_type(), create_promise_type(create_int_type())) },
        false,
        true,
      ),
    ],
  ]);

  for (const stmt of program.statements.get_items()) {
    const r = create_void_type();
    environment = stmt.typecheck(environment, substitution, r);
  }
}
