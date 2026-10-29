async function alpha(){
  print("alpha start");
  sleep(2);
  print("alpha end");
  return 1;
}

async function beta(){
  print("beta start");
  sleep(2);
  print("beta end");
  return 2;
}

let pa = alpha();
let pb = beta();
print(await pa);
print(await pb);
