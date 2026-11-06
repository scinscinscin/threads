import { describe, expect, it } from "vitest";
import { atom, compound } from "../src/typechecker/ast";
import { create_type } from "../src/typechecker";

describe("create_type", () => {
  it("builds the zero-argument atom types", () => {
    expect(create_type("number")).toEqual(atom("number"));
    expect(create_type("bool")).toEqual(atom("bool"));
    expect(create_type("str")).toEqual(atom("str"));
    expect(create_type("null")).toEqual(atom("null"));
    expect(create_type("void")).toEqual(atom("void"));
    expect(create_type("any")).toEqual(atom("any"));
  });

  it("defaults the type arguments to an empty array", () => {
    expect(create_type("number", [])).toEqual(atom("number"));
  });

  it("builds the parameterized compound types", () => {
    expect(create_type("array", [atom("number")])).toEqual(compound("array", [atom("number")]));
    expect(create_type("promise", [atom("number")])).toEqual(compound("promise", [atom("number")]));
    expect(create_type("f", [atom("str"), atom("bool")])).toEqual(compound("f", [atom("str"), atom("bool")]));
    // n-ary function type: f(p1, ..., pn, R)
    expect(create_type("f", [atom("number"), atom("str"), atom("bool")])).toEqual(
      compound("f", [atom("number"), atom("str"), atom("bool")]),
    );
  });

  it("rejects unknown type names", () => {
    expect(() => create_type("channel")).toThrowError('Unknown type: "channel"');
  });

  it("rejects type arguments on zero-argument types", () => {
    expect(() => create_type("number", [atom("bool")])).toThrowError('Type "number" takes no type arguments');
    expect(() => create_type("void", [atom("number")])).toThrowError('Type "void" takes no type arguments');
  });
});
