import { describe, expect, it } from "vitest";
import { ColumnAndRow, Token as SlexToken } from "@scinorandex/slex";
import { Token, TokenType } from "../src/lexer";
import { atom, compound, Compound, Term, variable, Var } from "../src/typechecker/ast";
import { Substitution } from "../src/typechecker/unify";
import {
  create_binding,
  create_type,
  env_free_vars,
  generalize,
  instantiate_binding,
  TypeCheckError,
  TypecheckContext,
  TypeEnvironment,
} from "../src/typechecker";
import { TypeConcreteNode } from "../src/parser/nodes/types";

const var_name = (t: Term): string => (t as Var).name;
/** A synthetic annotation token; only the lexeme (and error positions) matter. */
const token = (lexeme: string): Token => new SlexToken(TokenType.IDENTIFIER, lexeme, new ColumnAndRow(1, 1), {});

describe("generalize", () => {
  it("declares variables minted during the enclosing infer", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    const from = ctx.fresh.value();
    const t = ctx.fresh.next();
    const poly = generalize(t, new Map(), sub, from, ctx);
    expect(poly.vars).toEqual([t.name]);
    expect(poly.type).toEqual(t);
  });

  it("keeps bound variables resolved and monomorphic", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    const from = ctx.fresh.value();
    const t = ctx.fresh.next();
    sub.bind(t.name, atom("number"));
    const poly = generalize(t, new Map(), sub, from, ctx);
    expect(poly.vars).toEqual([]);
    expect(poly.type).toEqual(atom("number"));
  });

  it("declares in-range vars and replaces out-of-range aliases with fresh declared vars", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    const old = ctx.fresh.next(); // minted before `from`: an alias, e.g. from checking the value
    const from = ctx.fresh.value();
    const t = ctx.fresh.next(); // minted during this infer

    const poly = generalize(compound("f", [old, t]), new Map(), sub, from, ctx);

    expect(poly.vars).toHaveLength(2);
    const type = poly.type as Compound;
    // position 0 (the alias) got a fresh declared var, position 1 kept its in-range var
    expect(var_name(type.args[0])).toBe(poly.vars[1]);
    expect(var_name(type.args[1])).toBe(t.name);
    // the alias is not shared with the older variable
    expect(var_name(type.args[0])).not.toBe(old.name);
  });

  it("keeps variables linked to an unprocessed binding's placeholder shape undeclared", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    // another binding's still-uncommitted placeholder, committed to a shape
    // containing the variable v
    const placeholder = ctx.fresh.next();
    const v = ctx.fresh.next();
    sub.bind(placeholder.name, compound("f", [v]));
    const other = create_binding({ vars: [], type: placeholder }, { mutable: true, placeholder: placeholder.name });
    const env: TypeEnvironment = new Map([["g", other]]);

    const from = ctx.fresh.value();
    const t = ctx.fresh.next(); // this infer's variable, linked to v
    sub.bind(t.name, v);

    const poly = generalize(t, env, sub, from, ctx);

    // not declared: the other binding's commit will constrain the class, and
    // declaring it here would let instantiate_binding drop that constraint
    expect(poly.vars).toEqual([]);
    expect(var_name(poly.type)).toBe(v.name);
  });

  it("still declares variables that only share a processed binding's placeholder", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    // a processed binding: its polytype is no longer the placeholder variable,
    // so reads of it re-bind the placeholder to per-read instances
    const placeholder = ctx.fresh.next();
    const declared = ctx.fresh.next();
    sub.bind(placeholder.name, compound("f", [declared]));
    const other = create_binding({ vars: [declared.name], type: compound("f", [declared]) }, {
      mutable: true,
      placeholder: placeholder.name,
    });
    const env: TypeEnvironment = new Map([["g", other]]);

    const from = ctx.fresh.value();
    const t = ctx.fresh.next();
    sub.bind(t.name, declared); // linked to the processed binding's declared var

    const poly = generalize(t, env, sub, from, ctx);

    expect(poly.vars).toHaveLength(1);
    expect(var_name(poly.type)).toBe(poly.vars[0]);
    expect(var_name(poly.type)).not.toBe(declared.name);
  });

  it("replaces variables free in the environment rather than sharing them", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    // a function-parameter-style binding: an unbound var the binding does not declare
    const param = ctx.fresh.next();
    const env: TypeEnvironment = new Map([["x", create_binding({ vars: [], type: param }, { mutable: true })]]);
    expect(env_free_vars(env)).toContain(param.name);

    const from = ctx.fresh.value();
    const t = ctx.fresh.next(); // the value's var, unified with the parameter
    sub.bind(t.name, param);

    const poly = generalize(t, env, sub, from, ctx);

    expect(poly.vars).toHaveLength(1);
    expect(var_name(poly.type)).toBe(poly.vars[0]);
    expect(var_name(poly.type)).not.toBe(param.name);
  });

  it("resolves compounds to their concrete form when fully determined", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    const from = ctx.fresh.value();
    const t = ctx.fresh.next();
    sub.bind(t.name, create_type("number"));
    const poly = generalize(create_type("array", [t]), new Map(), sub, from, ctx);
    expect(poly.vars).toEqual([]);
    expect(poly.type).toEqual(create_type("array", [create_type("number")]));
  });
});

describe("instantiate_binding", () => {
  it("gives each read an independent instance", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    const declared = variable("T0");
    const binding = create_binding({ vars: [declared.name], type: compound("f", [declared, declared]) }, {
      mutable: true,
    });

    const a = instantiate_binding(binding, sub, ctx) as Compound;
    const b = instantiate_binding(binding, sub, ctx) as Compound;

    expect(var_name(a.args[0])).not.toBe(var_name(b.args[0]));
    expect(var_name(a.args[0])).not.toBe(declared.name);
    // the binding's stored type is untouched
    expect((binding.poly.type as Compound).args.map(var_name)).toEqual([declared.name, declared.name]);
  });

  it("passes monomorphic types through unchanged", () => {
    const ctx = new TypecheckContext();
    const sub = new Substitution();
    const binding = create_binding({ vars: [], type: create_type("array", [create_type("number")]) }, { mutable: true });
    expect(instantiate_binding(binding, sub, ctx)).toEqual(create_type("array", [create_type("number")]));
  });
});

describe("pass state isolation", () => {
  it("numbers fresh variables independently per context", () => {
    const a = new TypecheckContext();
    const b = new TypecheckContext();

    expect(var_name(a.fresh.next())).toBe("t0");
    expect(var_name(b.fresh.next())).toBe("t0");
    expect(var_name(a.fresh.next())).toBe("t1");
    expect(a.fresh.value()).toBe(2);
    expect(b.fresh.value()).toBe(1);
  });

  it("keeps aliases declared in one context invisible to another", () => {
    const a = new TypecheckContext();
    const b = new TypecheckContext();

    a.aliases.declare(token("Pos"), null, new TypeConcreteNode(token("number")));

    expect(a.aliases.resolve("Pos")).toEqual({ kind: "complete", term: create_type("number") });

    expect(() => b.aliases.resolve("Pos")).toThrow(TypeCheckError);
  });
});
