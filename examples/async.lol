let worker = async function() {
  print("worker started");
  let value = await resolve();
  print("worker got", value);
  return value + 1;
};

print("main started");
let result = await worker();
print("main got", result);
