import { beforeEach, describe, expect, it } from "vitest";
import { atom, compound, Term, variable } from "../src/typechecker/ast";
import { apply_term, create_subst, resolve, Substitution, unify, unify_write } from "../src/typechecker/unify";

const int = (): Term => atom("int");
const bool = (): Term => atom("bool");
const f = (...args: Term[]): Term => compound("f", args);

describe("unify_write", () => {
  let sub: Substitution;

  beforeEach(() => {
    sub = new Substitution();
  });

  it("unifies equal atoms", () => {
    expect(unify_write(int(), int(), sub)).toBe(true);
  });

  it("rejects unequal atoms", () => {
    expect(unify_write(int(), bool(), sub)).toBe(false);
  });

  it("rejects an atom against a compound", () => {
    expect(unify_write(int(), f(int()), sub)).toBe(false);
  });

  it("binds a variable to a term, which then resolves to it", () => {
    const x = variable("X");
    expect(unify_write(x, int(), sub)).toBe(true);
    expect(resolve(x, sub.map)).toEqual(int());
  });

  it("unifies a variable with itself trivially", () => {
    expect(unify_write(variable("X"), variable("X"), sub)).toBe(true);
  });

  it("unifies nested compounds argument by argument", () => {
    const x = variable("X");
    expect(unify_write(f(x, bool()), f(int(), bool()), sub)).toBe(true);
    expect(resolve(x, sub.map)).toEqual(int());
  });

  it("rejects mismatched functors", () => {
    expect(unify_write(f(int()), compound("array", [int()]), sub)).toBe(false);
  });

  it("rejects mismatched arity", () => {
    expect(unify_write(f(int()), f(int(), bool()), sub)).toBe(false);
  });

  it("rolls back partial bindings when a later argument fails", () => {
    const x = variable("X");
    // first arg binds X := bool, second arg (int vs bool) fails
    expect(unify_write(f(x, int()), f(bool(), bool()), sub)).toBe(false);
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
    sub.bind(x.name, int());
    sub.unmark(m);
    expect(sub.map.has(x.name)).toBe(false);
  });
});

describe("unify (pure)", () => {
  it("returns an extended substitution on success", () => {
    const x = variable("X");
    const out = unify(x, int(), create_subst());
    expect(out).not.toBeNull();
    expect(resolve(x, out!)).toEqual(int());
  });

  it("returns null on failure", () => {
    expect(unify(int(), bool(), create_subst())).toBeNull();
  });
});

describe("apply_term", () => {
  it("substitutes variables under compounds", () => {
    const sub = new Substitution();
    const x = variable("X");
    sub.bind(x.name, atom("str"));
    expect(apply_term(f(x, int()), sub.map)).toEqual(f(atom("str"), int()));
  });

  it("passes atoms and unbound variables through unchanged", () => {
    expect(apply_term(int(), new Map())).toEqual(int());
    expect(apply_term(variable("X"), new Map())).toEqual(variable("X"));
  });
});
