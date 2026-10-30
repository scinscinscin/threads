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
