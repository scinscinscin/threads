async function main() {
  console.log(1);

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      console.log(2);
      resolve();
    }, 1000);
  });

  console.log(12);
}

main().catch(console.error);
