import { Token } from "../../lexer";
import { create_type, resolve_type_name, TypeCheckError } from "../../typechecker";
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

  abstract lower(): Term;
}

/** A bare type name: `int`, `str`, ... A bare parametric name (no `<...>`) is a type error. */
export class TypeConcreteNode extends TypeExpressionNode {
  constructor(public readonly name: Token) {
    super();
  }

  lower(): Term {
    const info = resolve_type_name(this.name.lexeme, this.name);
    if (info.arity !== 0) throw new TypeCheckError(`Type "${this.name.lexeme}" requires a type argument`, this.name);
    return create_type(info.registry);
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

  lower(): Term {
    const info = resolve_type_name(this.name.lexeme, this.name);
    if (info.arity === 0) throw new TypeCheckError(`Type "${this.name.lexeme}" takes no type arguments`, this.name);
    if (this.args.length === info.arity)
      return create_type(
        info.registry,
        this.args.map((a) => a.lower()),
      );
    throw new TypeCheckError(
      `Type "${this.name.lexeme}" takes ${info.arity} type argument, got ${this.args.length}`,
      this.name,
    );
  }
}

/** An array type: `int[]`. */
export class TypeArrayNode extends TypeExpressionNode {
  constructor(public readonly inner: TypeExpressionNode) {
    super();
  }

  lower(): Term {
    return create_type("array", [this.inner.lower()]);
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

  lower(): Term {
    return create_type("f", [...this.params.map((p) => p.lower()), this.return_type.lower()]);
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

  lower(): Term {
    const entries: [string, Term][] = [];
    const seen = new Set<string>();
    for (const prop of this.properties) {
      const key = prop.key.lexeme;
      if (seen.has(key)) throw new TypeCheckError(`Duplicate property "${key}" in object type`, prop.key);
      seen.add(key);
      entries.push([key, prop.value.lower()]);
    }

    // Property entries are named compounds, not registered types, so they are
    // built with raw `compound`; only the `obj` wrapper goes through create_type.
    return create_type("obj", entries.map(([key, type]) => compound(key, [type])));
  }
}
