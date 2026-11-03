import fs from "fs/promises";
import path from "path";
import { Interpreter } from "./interpreter";
import { parse_program } from "./parser";
import { VariableDeclarationNode } from "./parser/nodes/statements";
import { show_polytype, TypeCheckError, typecheck } from "./typechecker";
import { compound, show_type, variable } from "./typechecker/ast";

async function main() {
  const args = process.argv.slice(2);
  const debug_types = args.includes("--debug-types");
  const file = args.find((a) => !a.startsWith("--")) ?? path.resolve(process.cwd(), "example_program.lol");
  const program = parse_program(await fs.readFile(file, "utf8"));

  let checked: ReturnType<typeof typecheck>;
  try {
    checked = typecheck(program);
  } catch (error) {
    if (error instanceof TypeCheckError) {
      const position = error.token === undefined ? "" : ` (${error.token.line}:${error.token.column})`;
      console.error(`Type error${position}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // --debug-types: report the type each top-level declaration committed to.
  // Printed to stderr so the program's stdout stays clean.
  if (debug_types) {
    for (const stmt of program.statements.get_items()) {
      if (!(stmt instanceof VariableDeclarationNode)) continue;
      const binding = checked.env.get(stmt.variable_name.lexeme);
      if (binding === undefined) continue;
      console.error(
        `[types] ${stmt.variable_name.line}:${stmt.variable_name.column} ${stmt.variable_name.lexeme} : ${show_polytype(
          binding.poly,
          checked.sub,
        )}`,
      );
    }

    for (const { name, name_token, record } of checked.ctx.aliases.top_level()) {
      const shown = show_type(
        record.kind === "complete"
          ? record.term
          : compound(
              record.registry,
              Array.from({ length: record.arity }, () => variable("t")),
            ),
      );

      console.error(`[types] ${name_token.line}:${name_token.column} type ${name} = ${shown}`);
    }
  }

  const interpreter = new Interpreter(program.statements.get_items());
  interpreter.run();
}

main();
