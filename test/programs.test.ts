import { describe, expect, it } from "vitest";
import { parse_program } from "../src/parser";
import { show_polytype, TypeCheckError, typecheck } from "../src/typechecker";

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
  it("rejects assigning a string to an number variable", () => {
    expect_type_error(
      `
let x = 1;
x = "a";
`,
      `Assignment to "x": got str, expected number`,
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
      `Argument 1: got str, expected number`,
    );
  });

  it("rejects assigning a string element to an array of ints", () => {
    expect_type_error(
      `
let arr = [1];
arr[0] = "s";
`,
      `Array assignment: got str, expected number`,
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

  it("rejects a non-number operand of unary minus", () => {
    expect_type_error(
      `
print(-"s");
`,
      `Unary "-" requires an number operand: got str, expected number`,
    );
  });
});

describe("typechecker: type annotations (accepted)", () => {
  it("annotates a variable with an atom type", () => {
    typecheck_source(`
let x: number = 5;
print(x + 1);
`);
  });

  it("annotates arrays, including nested arrays", () => {
    typecheck_source(`
let a: number[] = [1, 2];
print(a[0] + a[1]);
let b: number[][] = [[1], [2]];
print(b[1][0]);
`);
  });

  it("annotates a promise with a parametric type", () => {
    typecheck_source(`
let p: Promise<number> = resolve();
print(await p);
`);
  });

  it("annotates function types, including zero-argument and nested", () => {
    typecheck_source(`
let f: (number, str) => bool = function(a, b) {
  return a + 1 > 0;
};
print(f(1, "s"));
let g: () => number = function() {
  return 3;
};
print(g());
let h: ((number) => str) => bool = function(f) {
  return f(1) == "a";
};
print(h(function(x) {
  return "a";
}));
`);
  });

  it("annotates parameters and the return type of a function", () => {
    typecheck_source(`
let add = function(a: number, b: number): number {
  return a + b;
};
print(add(1, 2));
let f: (number) => number = function(x: number): number {
  return x;
};
print(f(2));
`);
  });

  it("annotates an async return type as the inner type, auto promise-wrapped", () => {
    typecheck_source(`
let a = async function(): number {
  return 3;
};
print(await a());
`);
  });

  it("treats a Promise annotation on an async function as promise-of-promise", () => {
    typecheck_source(`
let outer = async function(): Promise<number> {
  return resolve();
};
let mid = await outer();
print(await mid);
`);
  });

  it("keeps partially annotated functions polymorphic in their unannotated parts", () => {
    typecheck_source(`
let h = function(x: number, y) {
  return y;
};
print(h(1, "s"));
print(h(2, 3));
`);
  });

  it("annotates a for-loop initializer", () => {
    typecheck_source(`
let total = 0;
for (let i: number = 0; i < 3; i = i + 1) {
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
let x: number = "s";
`,
      `Initializer for "x": got str, expected number`,
    );
  });

  it("rejects a return expression that does not match the return annotation", () => {
    expect_type_error(
      `
let f = function(x): number {
  return "s";
};
`,
      `Literal "s": got str, expected number`,
    );
  });

  it("rejects a body that falls off the end with a non-void return annotation", () => {
    expect_type_error(
      `
let f = function(): number {};
`,
      `Function body falls off the end: got null, expected number`,
    );
  });

  it("rejects an annotated parameter called with a wrong argument", () => {
    expect_type_error(
      `
let f = function(x: number) {
  return x + 1;
};
f("s");
`,
      `Argument 1: got str, expected number`,
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
let p: Promise<number, str> = 1;
`,
      `Type "Promise" takes 1 type argument, got 2`,
    );
  });

  it("rejects type arguments on a concrete type name", () => {
    expect_type_error(
      `
let x: number<bool> = 1;
`,
      `Type "number" takes no type arguments`,
    );
  });
});

describe("typechecker: object type annotations (accepted)", () => {
  it("annotates a variable with an object type", () => {
    typecheck_source(`
let p: {a: number; b: str} = {a: 1, b: "s"};
print(p.a + 1);
print(p.b);
`);
  });

  it("matches fields by name, not position", () => {
    typecheck_source(`
let p: {a: number; b: str} = {b: "s", a: 1};
print(p.a);
`);
  });

  it("annotates nested object types", () => {
    typecheck_source(`
let p: {outer: {x: number}} = {outer: {x: 2}};
print(p.outer.x);
`);
  });

  it("annotates arrays of objects", () => {
    typecheck_source(`
let arr: {v: number}[] = [{v: 1}, {v: 2}];
print(arr[1].v);
`);
  });

  it("annotates function and promise fields", () => {
    typecheck_source(`
let f: {apply: (number) => number} = {apply: function(x: number): number {
  return x + 1;
}};
print(f.apply(1));
let p: {q: Promise<number>} = {q: resolve()};
print(await p.q);
`);
  });

  it("annotates fields with string literal keys", () => {
    // one double-quoted string per line: the lexer's string rule (pre-existing)
    // swallows up to the last quote on a line
    typecheck_source(`
let p: {"my key": number;
  a: str} = {
  "my key": 3,
  a: "s"
};
print(p["my key"]);
`);
  });

  it("annotates function parameters with object types", () => {
    typecheck_source(`
let bump = function(p: {a: number}): number {
  return p.a + 1;
};
print(bump({a: 5}));
`);
  });
});

describe("typechecker: object type annotations (rejected)", () => {
  it("rejects a field with the wrong type", () => {
    expect_type_error(
      `
let p: {a: number} = {a: "s"};
`,
      `Initializer for "p": got obj(a: str), expected obj(a: number)`,
    );
  });

  it("rejects a literal missing an annotated field", () => {
    expect_type_error(
      `
let p: {a: number; b: str} = {a: 1};
`,
      `Initializer for "p": got obj(a: number), expected obj(a: number, b: str)`,
    );
  });

  it("rejects a literal with an extra field", () => {
    expect_type_error(
      `
let p: {a: number} = {a: 1, b: 2};
`,
      `Initializer for "p": got obj(a: number, b: number), expected obj(a: number)`,
    );
  });

  it("rejects duplicate field names in an object type", () => {
    expect_type_error(
      `
let p: {a: number; a: str} = {a: 1};
`,
      `Duplicate property "a" in object type`,
    );
  });

  it("rejects an unknown type name in a field", () => {
    expect_type_error(
      `
let p: {a: float} = {a: 1};
`,
      `Unknown type name: "float"`,
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
let f: (number) => number = function(x) {
  return g(x);
};
let g: (number) => number = function(x) {
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

  it("returns the final environment with committed types", () => {
    const { env, sub } = typecheck(parse_program(`
let early = function() {
  return after();
};
let after = function() {
  return 1;
};
`));
    // early committed against after's placeholder; after's commit bound that
    // placeholder to number, and the final display resolves it (nullary functions
    // are f(R), shown without the -> sugar)
    expect(show_polytype(env.get("early")!.poly, sub)).toBe("f(number)");
    expect(show_polytype(env.get("after")!.poly, sub)).toBe("f(number)");
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
      `Argument 1: got str, expected number`,
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
      `Type of "n": got str, expected number`,
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
      `Initializer for "s": got number, expected str`,
    );
  });
});

describe("typechecker: type aliases (accepted)", () => {
  it("aliases a built-in type name", () => {
    typecheck_source(`
type Pos = number:
let x: Pos = 5;
print(x + 1);
`);
  });

  it("aliases a complete parametric type", () => {
    typecheck_source(`
type P = Promise<number>:
let x: P = resolve();
print(await x);
`);
  });

  it("aliases a parametric name and uses it with its type argument", () => {
    typecheck_source(`
type P = Promise:
let x: P<number> = resolve();
print(await x);
`);
  });

  it("aliases array, function, and object types", () => {
    typecheck_source(`
type Ints = number[]:
let a: Ints = [1, 2];
print(a[0] + a[1]);
type Inc = (number) => number:
let f: Inc = function(x) {
  return x + 1;
};
print(f(1));
type Point = {x: Ints; y: number}:
let p: Point = {x: [3], y: 4};
print(p.x[0] + p.y);
`);
  });

  it("chains an alias to another alias", () => {
    typecheck_source(`
type Ints = number[]:
type Numbers = Ints:
let a: Numbers = [1];
print(a[0]);
type Q = Promise<number>:
type R = Q:
let p: R = resolve();
print(await p);
`);
  });

  it("uses an alias in parameter and return annotations", () => {
    typecheck_source(`
type Pos = number:
let add = function(a: Pos, b: Pos): Pos {
  return a + b;
};
print(add(1, 2));
`);
  });

  it("uses an alias in a for-loop initializer", () => {
    typecheck_source(`
type Pos = number:
let total = 0;
for (let i: Pos = 0; i < 3; i = i + 1) {
  total = total + i;
}
print(total);
`);
  });

  it("resolves an alias declared after a top-level function that uses it", () => {
    typecheck_source(`
let f = function(): P {
  return 1;
};
type P = number:
print(f());
`);
  });

  it("scopes a block-local alias to its block and allows shadowing", () => {
    typecheck_source(`
type A = str:
{
  type A = number:
  let x: A = 1;
  print(x);
}
let y: A = "s";
print(y);
`);
  });

  it("sees a block-local alias from a function defined in the same block", () => {
    typecheck_source(`
{
  type A = number:
  let f = function(): A {
    return 3;
  };
  print(f());
}
`);
  });
});

describe("typechecker: type aliases (rejected)", () => {
  it("rejects an unknown type name in an alias target", () => {
    expect_type_error(
      `
type A = float:
`,
      `Unknown type name: "float"`,
    );
  });

  it("rejects aliasing a built-in type name", () => {
    expect_type_error(
      `
type number = str:
`,
      `Cannot define a type alias for the built-in type name "number"`,
    );
  });

  it("rejects a duplicate top-level alias", () => {
    expect_type_error(
      `
type A = number:
type A = str:
let x: A = 1;
`,
      `Duplicate type alias "A"`,
    );
  });

  it("rejects a bare use of a parametric alias", () => {
    expect_type_error(
      `
type P = Promise:
let x: P = 1;
`,
      `Type "P" requires a type argument`,
    );
  });

  it("rejects type arguments on a complete alias", () => {
    expect_type_error(
      `
type P = Promise<number>:
let x: P<str> = 1;
`,
      `Type "P" takes no type arguments`,
    );
  });

  it("rejects the wrong number of type arguments on a parametric alias", () => {
    expect_type_error(
      `
type P = Promise:
let x: P<number, str> = 1;
`,
      `Type "P" takes 1 type argument, got 2`,
    );
  });

  it("rejects a circular alias definition", () => {
    expect_type_error(
      `
type A = B:
type B = A:
let x: A = 1;
`,
      `Circular type alias definition: "A"`,
    );
  });

  it("rejects a self-referential alias", () => {
    expect_type_error(
      `
type A = A:
`,
      `Circular type alias definition: "A"`,
    );
  });
});

describe("typechecker: type constructors (accepted)", () => {
  it("substitutes type arguments for the declared parameters", () => {
    typecheck_source(`
type Testing<A, B, C> = A[]:
let x: Testing<number, bool, str> = [1];
print(x[0]);
`);
  });

  it("substitutes into object, array, and function types in the body", () => {
    typecheck_source(`
type Pair<A, B> = {first: A; second: B}:
let p: Pair<number, str> = {first: 1, second: "a"};
print(p.first);
type F<A> = A[]:
let v: F<F<number>> = [[1]];
print(v[0][0]);
type Id<A> = (A) => A:
let f: Id<number> = function(x): number {
  return x + 1;
};
print(f(1));
`);
  });

  it("nests one constructor's use inside another's body", () => {
    typecheck_source(`
type F<A> = G<A>[]:
type G<B> = {x: B}:
let v: F<number> = [{x: 1}];
print(v[0].x);
`);
  });

  it("scopes a parameter over the alias table, shadowing outer aliases", () => {
    typecheck_source(`
type A = str:
type F<A> = A:
let x: F<number> = 1;
let y: A = "s";
print(x);
print(y);
`);
  });

  it("allows a parameter to have the alias's own name", () => {
    typecheck_source(`
type A<A> = A:
let x: A<str> = "s";
print(x);
`);
  });

  it("uses a constructor as a built-in's type argument", () => {
    typecheck_source(`
type Pair<A, B> = {first: A; second: B}:
let make = async function(): Pair<number, bool> {
  return {first: 1, second: true};
};
let p: Promise<Pair<number, bool>> = make();
let q = await p;
print(q.first);
`);
  });

  it("aliases an applied constructor to a complete type", () => {
    typecheck_source(`
type Pair<A, B> = {first: A; second: B}:
type IP = Pair<number, bool>:
let p: IP = {first: 1, second: true};
print(p.second);
`);
  });

  it("scopes a constructor to its block and allows shadowing", () => {
    typecheck_source(`
type W<A> = str:
{
  type W<A> = number:
  let x: W<number> = 1;
  print(x);
}
let y: W<str> = "s";
print(y);
`);
  });
});

describe("typechecker: type constructors (rejected)", () => {
  it("rejects a bare use of a type constructor", () => {
    expect_type_error(
      `
type Testing<A, B, C> = A[]:
let x: Testing = 1;
`,
      `Type "Testing" requires a type argument`,
    );
  });

  it("rejects too few type arguments", () => {
    expect_type_error(
      `
type Testing<A, B, C> = A[]:
let x: Testing<number> = [1];
`,
      `Type "Testing" takes 3 type arguments, got 1`,
    );
  });

  it("rejects too many type arguments", () => {
    expect_type_error(
      `
type Testing<A, B, C> = A[]:
let x: Testing<number, bool, str, number> = [1];
`,
      `Type "Testing" takes 3 type arguments, got 4`,
    );
  });

  it("rejects a duplicate type parameter", () => {
    expect_type_error(
      `
type F<A, A> = number:
`,
      `Duplicate type parameter "A"`,
    );
  });

  it("rejects a built-in type name as a type parameter", () => {
    expect_type_error(
      `
type F<number> = number:
`,
      `Cannot define a type parameter for the built-in type name "number"`,
    );
  });

  it("rejects an unknown type name in a constructor's body", () => {
    expect_type_error(
      `
type F<A> = float[]:
`,
      `Unknown type name: "float"`,
    );
  });

  it("rejects a type argument on a type parameter", () => {
    expect_type_error(
      `
type F<A> = A<number>:
`,
      `Type "A" takes no type arguments`,
    );
  });

  it("rejects a self-referential type constructor", () => {
    expect_type_error(
      `
type F<A> = F<number>:
`,
      `Circular type alias definition: "F"`,
    );
  });

  it("rejects mutually recursive type constructors", () => {
    expect_type_error(
      `
type F<A> = G<A>:
type G<A> = F<A>:
`,
      `Circular type alias definition: "F"`,
    );
  });

  it("rejects a bare type constructor as an alias target", () => {
    expect_type_error(
      `
type F<A> = number:
type G = F:
`,
      `Type "F" requires a type argument`,
    );
  });
});
