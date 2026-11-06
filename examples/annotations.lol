let n: number = 5;
let name: str = "threads";
let nums: number[] = [1, 2];
let ready: Promise<number> = resolve();

print(n + nums[1]);
print(name);
print(await ready);

let double = function(x: number): number {
  return x * 2;
};
print(double(21));

let fetch = async function(): number {
  return await resolve();
};
print(await fetch());
