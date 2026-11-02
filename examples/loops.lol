let total = 0;
for (let i = 1; i <= 5; i = i + 1) {
  if (i == 3) continue;
  total = total + i;
}
print(total);

let count = 0;
while (count < 3) {
  print(count);
  count = count + 1;
}

let attempts = 0;
do {
  attempts = attempts + 1;
} while (attempts < 2);
print(attempts);
