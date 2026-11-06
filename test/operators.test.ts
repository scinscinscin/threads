import { describe, expect, it } from "vitest";
import { ColumnAndRow, Token as SlexToken } from "@scinorandex/slex";
import { TokenType } from "../src/lexer";
import { atom, compound, Term, Var } from "../src/typechecker/ast";
import {
  binary_operators,
  infer_binary_operator,
  infer_unary_operator,
  unary_operators,
} from "../src/typechecker/operators";
import { resolve, Substitution } from "../src/typechecker/unify";
import { TypecheckContext } from "../src/typechecker";

const var_name = (t: Term): string => (t as Var).name;
/** A synthetic operator token; only the lexeme (and error positions) matter. */
const token = (type: TokenType, lexeme: string) => new SlexToken(type, lexeme, new ColumnAndRow(1, 1), {});

const number = atom("number");
const str = atom("str");
const bool = atom("bool");

describe("binary operators", () => {
  it("types number arithmetic as number -> number -> number", () => {
    for (const [op, lexeme] of [
      [TokenType.MINUS, "-"],
      [TokenType.MULTIPLY, "*"],
      [TokenType.DIVIDE, "/"],
    ] as const) {
      const ctx = new TypecheckContext();
      const sub = new Substitution();
      expect(infer_binary_operator(op, number, number, sub, ctx, token(op, lexeme))).toEqual(number);
    }
  });

  it("types a non-number arithmetic operand as an error naming the operand", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(() => infer_binary_operator(TokenType.MINUS, str, number, sub, ctx, token(TokenType.MINUS, "-"))).toThrow(
      `Left operand of "-": got str, expected number`,
    );
    expect(() => infer_binary_operator(TokenType.MINUS, number, str, sub, ctx, token(TokenType.MINUS, "-"))).toThrow(
      `Right operand of "-": got str, expected number`,
    );
  });

  it("overloads + over number and str, tried in order", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(infer_binary_operator(TokenType.PLUS, number, number, sub, ctx, token(TokenType.PLUS, "+"))).toEqual(number);
    expect(infer_binary_operator(TokenType.PLUS, str, str, sub, ctx, token(TokenType.PLUS, "+"))).toEqual(str);
  });

  it("rejects mixed + operands", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(() => infer_binary_operator(TokenType.PLUS, number, str, sub, ctx, token(TokenType.PLUS, "+"))).toThrow(
      `Unsupported operands for "+"`,
    );
  });

  it("leaves equality operands unconstrained", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(infer_binary_operator(TokenType.EQUAL_EQUAL, number, str, sub, ctx, token(TokenType.EQUAL_EQUAL, "=="))).toEqual(
      bool,
    );
    expect(infer_binary_operator(TokenType.NOT_EQUAL, str, compound("promise", [number]), sub, ctx, token(TokenType.NOT_EQUAL, "!="))).toEqual(
      bool,
    );
    // an unconstrained operand stays free
    const v = ctx.fresh.next();
    infer_binary_operator(TokenType.EQUAL_EQUAL, v, str, sub, ctx, token(TokenType.EQUAL_EQUAL, "=="));
    expect(resolve(v, sub.map)).toEqual(v);
  });

  it("types comparisons as number -> number -> bool", () => {
    for (const [op, lexeme] of [
      [TokenType.LESS_THAN, "<"],
      [TokenType.GREATER_THAN, ">"],
      [TokenType.LESS_EQUAL, "<="],
      [TokenType.GREATER_EQUAL, ">="],
    ] as const) {
      const ctx = new TypecheckContext();
      const sub = new Substitution();
      expect(infer_binary_operator(op, number, number, sub, ctx, token(op, lexeme))).toEqual(bool);
    }
  });

  it("rejects a non-number comparison operand", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(() => infer_binary_operator(TokenType.LESS_THAN, str, number, sub, ctx, token(TokenType.LESS_THAN, "<"))).toThrow(
      `Left operand of "<": got str, expected number`,
    );
  });

  it("unifies short-circuit operands to a shared type", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(infer_binary_operator(TokenType.AND, number, number, sub, ctx, token(TokenType.AND, "&&"))).toEqual(number);

    const v = ctx.fresh.next();
    const w = ctx.fresh.next();
    const result = infer_binary_operator(TokenType.AND, v, w, sub, ctx, token(TokenType.AND, "&&"));
    expect(result.kind).toBe("var");
    expect(var_name(resolve(v, sub.map))).toBe(var_name(result));
    expect(var_name(resolve(w, sub.map))).toBe(var_name(result));
  });

  it("mints a fresh shared variable per attempt", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    const a = infer_binary_operator(TokenType.AND, ctx.fresh.next(), ctx.fresh.next(), sub, ctx, token(TokenType.AND, "&&"));
    const b = infer_binary_operator(TokenType.OR, ctx.fresh.next(), ctx.fresh.next(), sub, ctx, token(TokenType.OR, "||"));
    expect(var_name(a)).not.toBe(var_name(b));
  });

  it("reports short-circuit mismatches as the operands against each other", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(() => infer_binary_operator(TokenType.AND, number, str, sub, ctx, token(TokenType.AND, "&&"))).toThrow(
      `"&&" operands must have the same type: got str, expected number`,
    );
  });

  it("covers exactly the operators the runtime dispatches", () => {
    const binary = [
      TokenType.PLUS,
      TokenType.MINUS,
      TokenType.MULTIPLY,
      TokenType.DIVIDE,
      TokenType.EQUAL_EQUAL,
      TokenType.NOT_EQUAL,
      TokenType.LESS_THAN,
      TokenType.GREATER_THAN,
      TokenType.LESS_EQUAL,
      TokenType.GREATER_EQUAL,
      TokenType.AND,
      TokenType.OR,
    ];
    const unary = [TokenType.MINUS, TokenType.NOT, TokenType.AWAIT];
    expect([...binary_operators.keys()].sort()).toEqual([...binary].sort());
    expect([...unary_operators.keys()].sort()).toEqual([...unary].sort());
  });

  it("rejects an operator with no spec", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(() => infer_binary_operator(TokenType.COMMA, number, number, sub, ctx, token(TokenType.COMMA, ","))).toThrow(
      `Unsupported operator token: COMMA`,
    );
  });
});

describe("unary operators", () => {
  it("types unary minus as number -> number", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(infer_unary_operator(TokenType.MINUS, number, sub, ctx, token(TokenType.MINUS, "-"))).toEqual(number);
  });

  it("rejects a non-number operand of unary minus", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(() => infer_unary_operator(TokenType.MINUS, str, sub, ctx, token(TokenType.MINUS, "-"))).toThrow(
      `Unary "-" requires an number operand: got str, expected number`,
    );
  });

  it("constrains not's operand to nothing", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(infer_unary_operator(TokenType.NOT, number, sub, ctx, token(TokenType.NOT, "!"))).toEqual(bool);
  });

  it("unwraps promises under await", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(infer_unary_operator(TokenType.AWAIT, compound("promise", [number]), sub, ctx, token(TokenType.AWAIT, "await"))).toEqual(
      number,
    );
  });

  it("passes non-promises through await", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(infer_unary_operator(TokenType.AWAIT, number, sub, ctx, token(TokenType.AWAIT, "await"))).toEqual(number);

    // an unconstrained operand is assumed to be a promise, mirroring the
    // old infer's backtracking order
    const v = ctx.fresh.next();
    const result = infer_unary_operator(TokenType.AWAIT, v, sub, ctx, token(TokenType.AWAIT, "await"));
    expect(result.kind).toBe("var");
    expect(resolve(v, sub.map)).toEqual(compound("promise", [result]));
  });

  it("rejects an operator with no spec", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    expect(() => infer_unary_operator(TokenType.PLUS, number, sub, ctx, token(TokenType.PLUS, "+"))).toThrow(
      `Unsupported unary operator token: PLUS`,
    );
  });
});
