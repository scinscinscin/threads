import { beforeEach, describe, expect, it } from "vitest";
import { atom, compound, Term, variable } from "../src/typechecker/ast";
import { apply_term, create_subst, resolve, Substitution, unify, unify_write } from "../src/typechecker/unify";

const number = (): Term => atom("number");
const bool = (): Term => atom("bool");
const f = (...args: Term[]): Term => compound("f", args);

describe("unify_write", () => {
  let sub: Substitution;

  beforeEach(() => {
    sub = new Substitution();
  });

  it("unifies equal atoms", () => {
    expect(unify_write(number(), number(), sub)).toBe(true);
  });

  it("rejects unequal atoms", () => {
    expect(unify_write(number(), bool(), sub)).toBe(false);
  });

  it("rejects an atom against a compound", () => {
    expect(unify_write(number(), f(number()), sub)).toBe(false);
  });

  it("binds a variable to a term, which then resolves to it", () => {
    const x = variable("X");
    expect(unify_write(x, number(), sub)).toBe(true);
    expect(resolve(x, sub.map)).toEqual(number());
  });

  it("unifies a variable with itself trivially", () => {
    expect(unify_write(variable("X"), variable("X"), sub)).toBe(true);
  });

  it("unifies nested compounds argument by argument", () => {
    const x = variable("X");
    expect(unify_write(f(x, bool()), f(number(), bool()), sub)).toBe(true);
    expect(resolve(x, sub.map)).toEqual(number());
  });

  it("rejects mismatched functors", () => {
    expect(unify_write(f(number()), compound("array", [number()]), sub)).toBe(false);
  });

  it("rejects mismatched arity", () => {
    expect(unify_write(f(number()), f(number(), bool()), sub)).toBe(false);
  });

  it("rolls back partial bindings when a later argument fails", () => {
    const x = variable("X");
    // first arg binds X := bool, second arg (number vs bool) fails
    expect(unify_write(f(x, number()), f(bool(), bool()), sub)).toBe(false);
    expect(sub.map.has(x.name)).toBe(false);
  });

  it("applies the occurs check: X ~ f(X) fails and binds nothing", () => {
    const x = variable("X");
    expect(unify_write(x, f(x), sub)).toBe(false);
    expect(sub.map.has(x.name)).toBe(false);
  });

  it("supports mark/unmark backtracking", () => {
    const x = variable("X");
    const m = sub.mark();
    sub.bind(x.name, number());
    sub.unmark(m);
    expect(sub.map.has(x.name)).toBe(false);
  });
});

describe("unify (pure)", () => {
  it("returns an extended substitution on success", () => {
    const x = variable("X");
    const out = unify(x, number(), create_subst());
    expect(out).not.toBeNull();
    expect(resolve(x, out!)).toEqual(number());
  });

  it("returns null on failure", () => {
    expect(unify(number(), bool(), create_subst())).toBeNull();
  });
});

describe("apply_term", () => {
  it("substitutes variables under compounds", () => {
    const sub = new Substitution();
    const x = variable("X");
    sub.bind(x.name, atom("str"));
    expect(apply_term(f(x, number()), sub.map)).toEqual(f(atom("str"), number()));
  });

  it("passes atoms and unbound variables through unchanged", () => {
    expect(apply_term(number(), new Map())).toEqual(number());
    expect(apply_term(variable("X"), new Map())).toEqual(variable("X"));
  });
});
