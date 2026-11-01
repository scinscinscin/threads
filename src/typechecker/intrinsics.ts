import { Token } from "../lexer";
import { Term } from "./ast";
import { resolve, Substitution } from "./unify";
import { check_unify, create_type, TypeCheckError } from "./index";

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
  ["resolve", { params: [create_type("any")], variadic: true, return: create_type("promise", [create_type("int")]) }],
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
    check_unify(arg_types[i], param, sub, `Argument ${i + 1} of ${name}`);
  }
}
