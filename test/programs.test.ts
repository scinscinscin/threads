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

describe("typechecker: type annotations (accepted)", () => {
  it("annotates a variable with an atom type", () => {
    typecheck_source(`
let x: int = 5;
print(x + 1);
`);
  });

  it("annotates arrays, including nested arrays", () => {
    typecheck_source(`
let a: int[] = [1, 2];
print(a[0] + a[1]);
let b: int[][] = [[1], [2]];
print(b[1][0]);
`);
  });

  it("annotates a promise with a parametric type", () => {
    typecheck_source(`
let p: Promise<int> = resolve();
print(await p);
`);
  });

  it("annotates function types, including zero-argument and nested", () => {
    typecheck_source(`
let f: (int, str) => bool = function(a, b) {
  return a + 1 > 0;
};
print(f(1, "s"));
let g: () => int = function() {
  return 3;
};
print(g());
let h: ((int) => str) => bool = function(f) {
  return f(1) == "a";
};
print(h(function(x) {
  return "a";
}));
`);
  });

  it("annotates parameters and the return type of a function", () => {
    typecheck_source(`
let add = function(a: int, b: int): int {
  return a + b;
};
print(add(1, 2));
let f: (int) => int = function(x: int): int {
  return x;
};
print(f(2));
`);
  });

  it("annotates an async return type as the inner type, auto promise-wrapped", () => {
    typecheck_source(`
let a = async function(): int {
  return 3;
};
print(await a());
`);
  });

  it("treats a Promise annotation on an async function as promise-of-promise", () => {
    typecheck_source(`
let outer = async function(): Promise<int> {
  return resolve();
};
let mid = await outer();
print(await mid);
`);
  });

  it("keeps partially annotated functions polymorphic in their unannotated parts", () => {
    typecheck_source(`
let h = function(x: int, y) {
  return y;
};
print(h(1, "s"));
print(h(2, 3));
`);
  });

  it("annotates a for-loop initializer", () => {
    typecheck_source(`
let total = 0;
for (let i: int = 0; i < 3; i = i + 1) {
  total = total + i;
}
print(total);
`);
  });

  it("accepts a bare return when the return annotation is void", () => {
    typecheck_source(`
let f = function(x): void {
  print(x);
  return;
};
f(1);
`);
  });
});

describe("typechecker: type annotations (rejected)", () => {
  it("rejects an initializer that does not match the variable annotation", () => {
    expect_type_error(
      `
let x: int = "s";
`,
      `Initializer for "x": got str, expected int`,
    );
  });

  it("rejects a return expression that does not match the return annotation", () => {
    expect_type_error(
      `
let f = function(x): int {
  return "s";
};
`,
      `Literal "s": got str, expected int`,
    );
  });

  it("rejects a body that falls off the end with a non-void return annotation", () => {
    expect_type_error(
      `
let f = function(): int {};
`,
      `Function body falls off the end: got null, expected int`,
    );
  });

  it("rejects an annotated parameter called with a wrong argument", () => {
    expect_type_error(
      `
let f = function(x: int) {
  return x + 1;
};
f("s");
`,
      `Argument 1: got str, expected int`,
    );
  });

  it("rejects an unknown type name", () => {
    expect_type_error(
      `
let x: float = 1;
`,
      `Unknown type name: "float"`,
    );
  });

  it("rejects a bare parametric type name without its type argument", () => {
    expect_type_error(
      `
let p: Promise = 1;
`,
      `Type "Promise" requires a type argument`,
    );
  });

  it("rejects the wrong number of type arguments", () => {
    expect_type_error(
      `
let p: Promise<int, str> = 1;
`,
      `Type "Promise" takes 1 type argument, got 2`,
    );
  });

  it("rejects type arguments on a concrete type name", () => {
    expect_type_error(
      `
let x: int<bool> = 1;
`,
      `Type "int" takes no type arguments`,
    );
  });
});

describe("typechecker: deferred function bodies (accepted)", () => {
  it("typechecks a body that references a function declared later", () => {
    typecheck_source(`
let early = function() {
  return after();
};
let after = function() {
  return 1;
};
print(early());
`);
  });

  it("typechecks mutually recursive functions with a base case", () => {
    typecheck_source(`
let f = function(x) {
  if (x == 1) return 0;
  return g(x - 1);
};
let g = function(y) {
  return f(y);
};
print(f(3));
`);
  });

  it("typechecks a body that references a value declared later", () => {
    typecheck_source(`
let f = function() {
  return n;
};
let n = 5;
print(f());
`);
  });

  it("propagates constraints through a forward reference", () => {
    typecheck_source(`
let f = function(x) {
  return g(x);
};
let g = function(y) {
  return y + 1;
};
let a = f(1);
print(a + 1);
`);
  });

  it("typechecks mutually recursive functions with annotations", () => {
    typecheck_source(`
let f: (int) => int = function(x) {
  return g(x);
};
let g: (int) => int = function(x) {
  return x + 1;
};
print(f(1));
`);
  });

  it("typechecks a block-local body that references a later top-level declaration", () => {
    typecheck_source(`
let a = function() {
  let c = function() {
    return b;
  };
  return c;
};
let b = 1;
print(a()());
`);
  });

  it("accepts an unconstrained mutual cycle as a shared unknown", () => {
    typecheck_source(`
let f = function() {
  return g();
};
let g = function() {
  return f();
};
print(f());
`);
  });

  it("typechecks a reassigned function whose body references a later declaration", () => {
    typecheck_source(`
let f = function() {
  return 1;
};
f = function() {
  return later();
};
let later = function() {
  return 2;
};
print(f());
`);
  });
});

describe("typechecker: deferred function bodies (rejected)", () => {
  it("rejects an argument that conflicts with a constraint from a later declaration", () => {
    expect_type_error(
      `
let f = function(x) {
  return g(x);
};
let g = function(y) {
  return y + 1;
};
let a = f(1);
let b = f("s");
`,
      `Argument 1: got str, expected int`,
    );
  });

  it("still rejects a forward reference in a value expression", () => {
    expect_type_error(
      `
let m = n;
let n = 5;
`,
      `Undefined variable "n"`,
    );
  });

  it("rejects a declaration whose value conflicts with an earlier body's use", () => {
    expect_type_error(
      `
let f = function() {
  return n + 1;
};
let n = "s";
`,
      `Type of "n": got str, expected int`,
    );
  });

  it("rejects using a forward-referenced value with the wrong annotation", () => {
    expect_type_error(
      `
let f = function() {
  return n;
};
let n = 5;
let s: str = f();
`,
      `Initializer for "s": got int, expected str`,
    );
  });
});
