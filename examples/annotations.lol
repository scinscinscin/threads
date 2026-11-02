let n: int = 5;
let name: str = "threads";
let nums: int[] = [1, 2];
let ready: Promise<int> = resolve();

print(n + nums[1]);
print(name);
print(await ready);

let double = function(x: int): int {
  return x * 2;
};
print(double(21));

let fetch = async function(): int {
  return await resolve();
};
print(await fetch());
