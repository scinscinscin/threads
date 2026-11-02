import { describe, expect, it } from "vitest";
import { compound, variable } from "../src/typechecker/ast";
import { create_type, show_polytype } from "../src/typechecker";
import { Substitution } from "../src/typechecker/unify";

describe("show_polytype", () => {
  it("renders a monomorphic type", () => {
    expect(show_polytype({ vars: [], type: create_type("f", [create_type("int"), create_type("int")]) })).toBe(
      "int -> int",
    );
  });

  it("prefixes the declared variables with a forall", () => {
    const t = variable("t3");
    expect(show_polytype({ vars: ["t3"], type: compound("f", [t, t]) })).toBe("forall t3. t3 -> t3");
  });

  it("resolves the body through the given substitution", () => {
    const sub = new Substitution();
    sub.bind("t3", create_type("int"));
    expect(show_polytype({ vars: [], type: variable("t3") }, sub)).toBe("int");
  });

  it("keeps declared variables displayed as themselves even when reads instantiated them", () => {
    const sub = new Substitution();
    // instantiate_binding binds a declared variable to a per-read fresh variable,
    // which may then be constrained by the call site
    sub.bind("t3", variable("t9"));
    sub.bind("t9", create_type("int"));
    const poly = { vars: ["t3"], type: compound("f", [variable("t3"), variable("t3")]) };
    expect(show_polytype(poly, sub)).toBe("forall t3. t3 -> t3");
  });
});
