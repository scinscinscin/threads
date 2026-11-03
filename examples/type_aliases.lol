type Pos = int:
type P = Promise:

let n: Pos = 41;
print(n + 1);

let ready: P<int> = resolve();
print(await ready);

type Ints = int[]:
let nums: Ints = [1, 2, 3];
print(nums[0] + nums[1] + nums[2]);

type Point = { x: Pos; y: Pos }:
let p: Point = { x: 1, y: 2 };
print(p.x + p.y);

type Inc = (int) => int:
let f: Inc = function(x: Pos): Pos {
  return x + 10;
};

print(f(5));

{
  type Pos = str:
  let s: Pos = "shadowed";
  print(s);
}

print("type aliases are erased at runtime");
