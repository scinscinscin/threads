import { Token, TokenType } from "../lexer";
import { atom, compound, show_type, variable, Term } from "./ast";
import { apply_term, resolve, Subst, Substitution, unify_write } from "./unify";
import { term_vars, TypeCheckError, TypecheckContext } from "./index";

/** One typing candidate for an operator: "if the operands unify with `params`
 *  (in order), the expression has type `return`." `vars` declares template
 *  variables used in `params`/`return` (like a polytype's declared vars);
 *  each attempt instantiates them with fresh variables from the pass, so
 *  separate uses never share a variable. */
export type OperatorCandidate = { vars: string[]; params: Term[]; return: Term };

/** The typing of an operator: its candidates, tried in order with
 *  backtracking - the first candidate that unifies with the inferred operand
 *  types wins. Adding an operator, or an overload of an existing one, is a
 *  table entry. */
export type OperatorSpec = { candidates: OperatorCandidate[] };

const number = atom("number");
const str = atom("str");
const bool = atom("bool");
const any = atom("any");

export const binary_operators: Map<TokenType, OperatorSpec> = new Map([
  [
    TokenType.PLUS,
    {
      // overloaded: number + number or str + str, decided by backtracking
      candidates: [
        { vars: [], params: [number, number], return: number },
        { vars: [], params: [str, str], return: str },
      ],
    },
  ],
  [TokenType.MINUS, { candidates: [{ vars: [], params: [number, number], return: number }] }],
  [TokenType.MULTIPLY, { candidates: [{ vars: [], params: [number, number], return: number }] }],
  [TokenType.DIVIDE, { candidates: [{ vars: [], params: [number, number], return: number }] }],
  // the runtime compares any two values, so both sides stay unconstrained
  [TokenType.EQUAL_EQUAL, { candidates: [{ vars: [], params: [any, any], return: bool }] }],
  [TokenType.NOT_EQUAL, { candidates: [{ vars: [], params: [any, any], return: bool }] }],
  [TokenType.LESS_THAN, { candidates: [{ vars: [], params: [number, number], return: bool }] }],
  [TokenType.GREATER_THAN, { candidates: [{ vars: [], params: [number, number], return: bool }] }],
  [TokenType.LESS_EQUAL, { candidates: [{ vars: [], params: [number, number], return: bool }] }],
  [TokenType.GREATER_EQUAL, { candidates: [{ vars: [], params: [number, number], return: bool }] }],
  // the short-circuit operators return one of their operands, so both sides
  // must share a type
  [TokenType.AND, { candidates: [{ vars: ["t"], params: [variable("t"), variable("t")], return: variable("t") }] }],
  [TokenType.OR, { candidates: [{ vars: ["t"], params: [variable("t"), variable("t")], return: variable("t") }] }],
]);

export const unary_operators: Map<TokenType, OperatorSpec> = new Map([
  [TokenType.MINUS, { candidates: [{ vars: [], params: [number], return: number }] }],
  [TokenType.NOT, { candidates: [{ vars: [], params: [any], return: bool }] }],
  [
    TokenType.AWAIT,
    {
      // a promise unwraps to its inner type; anything else passes through
      // with its own type, mirroring the runtime
      candidates: [
        { vars: ["t"], params: [compound("promise", [variable("t")])], return: variable("t") },
        { vars: ["u"], params: [variable("u")], return: variable("u") },
      ],
    },
  ],
]);

type Kind = "binary" | "unary";

/** The first operand that failed to unify with a candidate's param. */
type Failure = { index: number; param: Term };

/** Replace a candidate's template variables with fresh variables minted for
 *  this attempt, so each attempt is independent (two `&&` expressions never
 *  share a type variable). */
function instantiate_candidate(candidate: OperatorCandidate, ctx: TypecheckContext): OperatorCandidate {
  const subst: Subst = new Map();
  for (const v of candidate.vars) subst.set(v, ctx.fresh.next());
  return {
    vars: [],
    params: candidate.params.map((t) => apply_term(t, subst)),
    return: apply_term(candidate.return, subst),
  };
}

/** True when a candidate's params share a template variable (like
 *  `(t, t) -> t` for `&&`): the failure is a mismatch between the operands,
 *  not against a concrete type. */
function is_shared_candidate(candidate: OperatorCandidate): boolean {
  const seen = new Set<string>();
  for (const param of candidate.params)
    for (const v of term_vars(param)) {
      if (seen.has(v)) return true;
      seen.add(v);
    }
  return false;
}

/** Infer the type of an operator application from its inferred operand types:
 *  try the operator's candidates in order, each on a backtrackable
 *  substitution mark; the first to unify wins and its `return` type is the
 *  result. */
function infer_operator_core(
  specs: Map<TokenType, OperatorSpec>,
  kind: Kind,
  op: TokenType,
  operand_types: Term[],
  sub: Substitution,
  ctx: TypecheckContext,
  op_token: Token,
): Term {
  const spec = specs.get(op);
  if (spec === undefined)
    throw new TypeCheckError(
      `${kind === "unary" ? "Unsupported unary operator token" : "Unsupported operator token"}: ${TokenType[op]}`,
      op_token,
    );

  let failure: Failure | null = null;
  for (const candidate of spec.candidates) {
    const inst = instantiate_candidate(candidate, ctx);
    const mark = sub.mark();

    let failed: Failure | null = null;
    for (let i = 0; i < operand_types.length; i++) {
      const param = inst.params[i];
      // `any` accepts an operand of any type, mirroring check_intrinsic_call
      if (param.kind === "atom" && param.name === "any") continue;
      if (!unify_write(operand_types[i], param, sub)) {
        failed = { index: i, param };
        break;
      }
    }

    if (failed === null) return resolve(inst.return, sub.map);
    sub.unmark(mark);
    if (failure === null) failure = failed;
  }

  // every spec has at least one candidate, so a completed loop means the
  // first candidate recorded a failure
  throw no_matching_candidate(kind, spec, failure!, operand_types, sub, op_token);
}

/** Build the error thrown when no candidate matches. The message mirrors the
 *  pre-table if-chains: a multi-candidate operator (like `+`) reports the
 *  operator, a shared-type candidate (like `&&`) reports the two operands
 *  against each other, and everything else reports the failed operand against
 *  its expected param (the `: got ..., expected ...` suffix is check_unify's
 *  format). */
function no_matching_candidate(
  kind: Kind,
  spec: OperatorSpec,
  failure: Failure,
  operand_types: Term[],
  sub: Substitution,
  op_token: Token,
): Error {
  const lexeme = op_token.lexeme;

  if (spec.candidates.length > 1) return new TypeCheckError(`Unsupported operands for "${lexeme}"`, op_token);

  const candidate = spec.candidates[0];
  if (is_shared_candidate(candidate))
    return new TypeCheckError(
      `"${lexeme}" operands must have the same type: got ${show_type(
        resolve(operand_types[1], sub.map),
      )}, expected ${show_type(resolve(operand_types[0], sub.map))}`,
    );

  const prefix =
    kind === "unary"
      ? `Unary "${lexeme}" requires an ${show_type(resolve(failure.param, sub.map))} operand`
      : `${failure.index === 0 ? "Left" : "Right"} operand of "${lexeme}"`;

  return new TypeCheckError(
    `${prefix}: got ${show_type(resolve(operand_types[failure.index], sub.map))}, expected ${show_type(
      resolve(failure.param, sub.map),
    )}`,
  );
}

/** Infer the type of a binary operator expression from its inferred operand
 *  types, per the `binary_operators` table. */
export function infer_binary_operator(
  op: TokenType,
  left: Term,
  right: Term,
  sub: Substitution,
  ctx: TypecheckContext,
  op_token: Token,
): Term {
  return infer_operator_core(binary_operators, "binary", op, [left, right], sub, ctx, op_token);
}

/** Infer the type of a unary operator expression from its inferred operand
 *  type, per the `unary_operators` table. */
export function infer_unary_operator(
  op: TokenType,
  operand: Term,
  sub: Substitution,
  ctx: TypecheckContext,
  op_token: Token,
): Term {
  return infer_operator_core(unary_operators, "unary", op, [operand], sub, ctx, op_token);
}
