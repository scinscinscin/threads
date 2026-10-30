import fs from "fs/promises";
import path from "path";
import { Interpreter } from "./interpreter";
import { parse_program } from "./parser";
import { TypeCheckError, typecheck } from "./typechecker";

async function main() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "example_program.lol");
  const program = parse_program(await fs.readFile(file, "utf8"));

  try {
    typecheck(program);
  } catch (error) {
    if (error instanceof TypeCheckError) {
      const position = error.token === undefined ? "" : ` (${error.token.line}:${error.token.column})`;
      console.error(`Type error${position}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const interpreter = new Interpreter(program.statements.get_items());
  interpreter.run();
}

main();
