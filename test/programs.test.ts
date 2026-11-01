import { describe, expect, it } from "vitest";
import { parse_program } from "../src/parser";
import { TypeCheckError, typecheck } from "../src/typechecker";

function typecheck_source(source: string): void {
  typecheck(parse_program(source));
}

function expect_type_error(source: string, message: string): void {
  try {
    typecheck_source(source);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeCheckError);
    expect((error as TypeCheckError).message).toBe(message);
    return;
  }
  throw new Error(`expected type error "${message}" but the program typechecked`);
}

describe("typechecker: accepted programs", () => {
  it("typechecks the baseline example program (async, await, resolve)", () => {
    typecheck_source(`
let first = async function (){
  print("Calling resolve() from first()");
  let a = resolve();

  print("Awaiting resolve()");
  let ret = await a;
  print("After awaiting resolve()");

  return ret;
};

print("The test is now starting");
let tld = await first();
print("End");
print(tld);
print(resolve);
`);
  });

  it("generalizes a let-bound identity function over multiple call sites", () => {
    typecheck_source(`
let id = function(x) {
  return x;
};
let a = id(1);
let b = id("s");
print(a);
print(b);
`);
  });

  it("generalizes async functions to promise returns", () => {
    typecheck_source(`
let id = async function(x) {
  return x;
};
let a = await id(1);
let b = await id("s");
print(a);
print(b);
`);
  });

  it("preserves polymorphism across self-assignment", () => {
    typecheck_source(`
let id = function(x) {
  return x;
};
id = id;
let a = id(1);
let b = id("s");
print(a);
print(b);
`);
  });

  it("narrows a generalized variable on reassignment", () => {
    typecheck_source(`
let id = function(x) {
  return x;
};
let f = id;
f = (function(y) {
  return y * 2;
});
print(f(21));
`);
  });

  it("keeps copies of a generalized variable independently polymorphic", () => {
    typecheck_source(`
let id = function(x) {
  return x;
};
let a = id;
let b = a;
b(1);
a("s");
print(b(2));
`);
  });

  it("shadows a variable with a separate binding in an inner block", () => {
    typecheck_source(`
let x = 1;
{
  let x = "s";
  x = "t";
  print(x);
}
print(x);
`);
  });

  it("generalizes a closure over its parameter independently of the parameter", () => {
    typecheck_source(`
let outer = function(x) {
  let g = function() {
    return x;
  };
  return g;
};
let a = outer(1);
print(a());
let b = outer("s");
print(b());
`);
  });

  it("narrows an array of ints on element assignment", () => {
    typecheck_source(`
let arr = [1, 2];
arr[0] = 3;
print(arr[0] + arr[1]);
`);
  });

  it("keeps a generalized function polymorphic inside an array", () => {
    typecheck_source(`
let f = function(x) {
  return x;
};
let arr = [f];
let a = arr[0](1);
let b = arr[0]("s");
print(a);
print(b);
`);
  });

  it("generalizes a function returning a one-element array", () => {
    typecheck_source(`
let mkarr = function(x) {
  return [x];
};
let a = mkarr(1);
let b = mkarr("s");
print(a[0]);
print(b[0]);
`);
  });
});

describe("typechecker: rejected programs", () => {
  it("rejects assigning a string to an int variable", () => {
    expect_type_error(
      `
let x = 1;
x = "a";
`,
      `Assignment to "x": got str, expected int`,
    );
  });

  it("rejects reassignment through a captured variable at the defining scope", () => {
    expect_type_error(
      `
let id = function(x) {
  return x;
};
let handler = id;
let swap = function() {
  handler = (function(y) {
    return y + 1;
  });
};
swap();
handler("a");
`,
      `Argument 1: got str, expected int`,
    );
  });

  it("rejects assigning a string element to an array of ints", () => {
    expect_type_error(
      `
let arr = [1];
arr[0] = "s";
`,
      `Array assignment: got str, expected int`,
    );
  });

  it("rejects a call with too many arguments", () => {
    expect_type_error(
      `
let id = function(x) {
  return x;
};
id(1, 2);
`,
      `Function expects 1 argument(s), got 2`,
    );
  });

  it("rejects a non-int operand of unary minus", () => {
    expect_type_error(
      `
print(-"s");
`,
      `Unary "-" requires an int operand: got str, expected int`,
    );
  });
});
