import fs from "fs/promises";
import path from "path";
import { Interpreter } from "./interpreter";
import { parse_program } from "./parser";

async function main() {
  const file = process.argv[2] ?? path.resolve(process.cwd(), "example_program.lol");
  const program = parse_program(await fs.readFile(file, "utf8"));
  const interpreter = new Interpreter(program.statements.get_items());
  interpreter.run();
}

main();
