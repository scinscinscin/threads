import fs from "fs/promises";
import path from "path";
import { Interpreter } from "./interpreter";
import { parse_program } from "./parser";
import { VariableDeclarationNode } from "./parser/nodes/statements";
import { show_polytype, TypeCheckError, typecheck } from "./typechecker";
import { compound, show_type, Term, variable } from "./typechecker/ast";
import { apply_term } from "./typechecker/unify";

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
      let shown: string;
      let params = "";
      if (record.kind === "complete") {
        shown = show_type(record.term);
      } else if (record.kind === "parametric") {
        shown = show_type(compound(record.registry, Array.from({ length: record.arity }, () => variable("t"))));
      } else {
        // a user-defined type constructor: show the body with its type
        // parameters renamed back to their declared names
        const renamed = new Map<string, Term>(record.params.map((param, i) => [record.param_vars[i], variable(param)]));
        shown = show_type(apply_term(record.body, renamed));
        params = `<${record.params.join(", ")}>`;
      }

      console.error(`[types] ${name_token.line}:${name_token.column} type ${name}${params} = ${shown}`);
    }
  }

  const interpreter = new Interpreter(program.statements.get_items());
  interpreter.run();
}

main();
