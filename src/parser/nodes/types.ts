import { Token } from "../../lexer";
import { create_type, TypecheckContext, TypeCheckError } from "../../typechecker";
import { Term, compound } from "../../typechecker/ast";
import { BaseNode } from "./base";

/**
 * A type annotation as parsed from source. The concrete subclasses mirror the
 * grammar's type expressions (`int`, `Promise<int>`, `int[]`, `(int, str) =>
 * bool`); each lowers itself to a static `Term` via `lower`, so unknown type
 * names become positioned type errors at typecheck time.
 */
export abstract class TypeExpressionNode extends BaseNode {
  constructor() {
    super();
  }

  abstract lower(ctx: TypecheckContext): Term;
}

/** A bare type name: `int`, `str`, ... A bare parametric name (no `<...>`) is a type error. */
export class TypeConcreteNode extends TypeExpressionNode {
  constructor(public readonly name: Token) {
    super();
  }

  lower(ctx: TypecheckContext): Term {
    // `AliasTable.resolve` resolves type aliases before built-in type names,
    // so aliases are transparent here; a parametric name -- built-in or
    // user-defined -- still needs its type arguments at the use site.
    const resolved = ctx.aliases.resolve(this.name.lexeme, this.name);
    if (resolved.kind !== "complete")
      throw new TypeCheckError(`Type "${this.name.lexeme}" requires a type argument`, this.name);

    return resolved.term;
  }
}

/** A parametric type with its type arguments: `Promise<int>`. */
export class TypeParametricNode extends TypeExpressionNode {
  constructor(
    public readonly name: Token,
    public readonly args: TypeExpressionNode[],
  ) {
    super();
  }

  lower(ctx: TypecheckContext): Term {
    // `AliasTable.resolve` resolves type aliases before built-in type names,
    // so a parametric alias splices its argument(s) into the aliased name, a
    // user-defined type constructor substitutes them for its type parameters,
    // and a complete alias takes no arguments -- exactly as for built-ins.
    const resolved = ctx.aliases.resolve(this.name.lexeme, this.name);
    if (resolved.kind === "complete")
      throw new TypeCheckError(`Type "${this.name.lexeme}" takes no type arguments`, this.name);

    const arity = resolved.kind === "parametric" ? resolved.arity : resolved.params.length;
    if (this.args.length !== arity)
      throw new TypeCheckError(
        `Type "${this.name.lexeme}" takes ${arity} type argument${arity === 1 ? "" : "s"}, got ${this.args.length}`,
        this.name,
      );

    const arg_types = this.args.map((a) => a.lower(ctx));
    return resolved.kind === "parametric"
      ? create_type(resolved.registry, arg_types)
      : ctx.aliases.apply_user_constructor(this.name.lexeme, arg_types);
  }
}

/** An array type: `int[]`. */
export class TypeArrayNode extends TypeExpressionNode {
  constructor(public readonly inner: TypeExpressionNode) {
    super();
  }

  lower(ctx: TypecheckContext): Term {
    return create_type("array", [this.inner.lower(ctx)]);
  }
}

/** A function type: `(int, str) => bool`. */
export class TypeFunctionNode extends TypeExpressionNode {
  constructor(
    public readonly params: TypeExpressionNode[],
    public readonly return_type: TypeExpressionNode,
  ) {
    super();
  }

  lower(ctx: TypecheckContext): Term {
    return create_type("f", [...this.params.map((p) => p.lower(ctx)), this.return_type.lower(ctx)]);
  }
}

/** A single field of an object type annotation: `key: T`. */
export class TypePropertyNode extends BaseNode {
  constructor(
    public readonly key: Token,
    public readonly value: TypeExpressionNode,
  ) {
    super();
  }
}

/** An object type annotation: `{a: int; b: str}`. Fields are `;`-delimited,
 *  keys are identifiers or string literals, and a field may not appear twice. */
export class TypeObjectNode extends TypeExpressionNode {
  constructor(public readonly properties: TypePropertyNode[]) {
    super();
  }

  lower(ctx: TypecheckContext): Term {
    const entries: [string, Term][] = [];
    const seen = new Set<string>();
    for (const prop of this.properties) {
      const key = prop.key.lexeme;
      if (seen.has(key)) throw new TypeCheckError(`Duplicate property "${key}" in object type`, prop.key);
      seen.add(key);
      entries.push([key, prop.value.lower(ctx)]);
    }

    // Property entries are named compounds, not registered types, so they are
    // built with raw `compound`; only the `obj` wrapper goes through create_type.
    return create_type(
      "obj",
      entries.map(([key, type]) => compound(key, [type])),
    );
  }
}
