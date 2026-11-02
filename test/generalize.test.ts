import { beforeEach, describe, expect, it } from "vitest";
import { atom, compound, Compound, Term, variable, Var } from "../src/typechecker/ast";
import { Substitution } from "../src/typechecker/unify";
import {
  create_binding,
  create_type,
  env_free_vars,
  fresh_var,
  generalize,
  get_fresh_counter_value,
  instantiate_binding,
  reset_fresh_vars,
  TypeEnvironment,
} from "../src/typechecker";

const var_name = (t: Term): string => (t as Var).name;

describe("generalize", () => {
  beforeEach(() => {
    reset_fresh_vars();
  });

  it("declares variables minted during the enclosing infer", () => {
    const sub = new Substitution();
    const from = get_fresh_counter_value();
    const t = fresh_var();
    const poly = generalize(t, new Map(), sub, from);
    expect(poly.vars).toEqual([t.name]);
    expect(poly.type).toEqual(t);
  });

  it("keeps bound variables resolved and monomorphic", () => {
    const sub = new Substitution();
    const from = get_fresh_counter_value();
    const t = fresh_var();
    sub.bind(t.name, atom("int"));
    const poly = generalize(t, new Map(), sub, from);
    expect(poly.vars).toEqual([]);
    expect(poly.type).toEqual(atom("int"));
  });

  it("declares in-range vars and replaces out-of-range aliases with fresh declared vars", () => {
    const sub = new Substitution();
    const old = fresh_var(); // minted before `from`: an alias, e.g. from checking the value
    const from = get_fresh_counter_value();
    const t = fresh_var(); // minted during this infer

    const poly = generalize(compound("f", [old, t]), new Map(), sub, from);

    expect(poly.vars).toHaveLength(2);
    const type = poly.type as Compound;
    // position 0 (the alias) got a fresh declared var, position 1 kept its in-range var
    expect(var_name(type.args[0])).toBe(poly.vars[1]);
    expect(var_name(type.args[1])).toBe(t.name);
    // the alias is not shared with the older variable
    expect(var_name(type.args[0])).not.toBe(old.name);
  });

  it("keeps variables linked to an unprocessed binding's placeholder shape undeclared", () => {
    const sub = new Substitution();
    // another binding's still-uncommitted placeholder, committed to a shape
    // containing the variable v
    const placeholder = fresh_var();
    const v = fresh_var();
    sub.bind(placeholder.name, compound("f", [v]));
    const other = create_binding({ vars: [], type: placeholder }, true, false, placeholder.name);
    const env: TypeEnvironment = new Map([["g", other]]);

    const from = get_fresh_counter_value();
    const t = fresh_var(); // this infer's variable, linked to v
    sub.bind(t.name, v);

    const poly = generalize(t, env, sub, from);

    // not declared: the other binding's commit will constrain the class, and
    // declaring it here would let instantiate_binding drop that constraint
    expect(poly.vars).toEqual([]);
    expect(var_name(poly.type)).toBe(v.name);
  });

  it("still declares variables that only share a processed binding's placeholder", () => {
    const sub = new Substitution();
    // a processed binding: its polytype is no longer the placeholder variable,
    // so reads of it re-bind the placeholder to per-read instances
    const placeholder = fresh_var();
    const declared = fresh_var();
    sub.bind(placeholder.name, compound("f", [declared]));
    const other = create_binding({ vars: [declared.name], type: compound("f", [declared]) }, true, false, placeholder.name);
    const env: TypeEnvironment = new Map([["g", other]]);

    const from = get_fresh_counter_value();
    const t = fresh_var();
    sub.bind(t.name, declared); // linked to the processed binding's declared var

    const poly = generalize(t, env, sub, from);

    expect(poly.vars).toHaveLength(1);
    expect(var_name(poly.type)).toBe(poly.vars[0]);
    expect(var_name(poly.type)).not.toBe(declared.name);
  });

  it("replaces variables free in the environment rather than sharing them", () => {
    const sub = new Substitution();
    // a function-parameter-style binding: an unbound var the binding does not declare
    const param = fresh_var();
    const env: TypeEnvironment = new Map([["x", create_binding({ vars: [], type: param }, true)]]);
    expect(env_free_vars(env)).toContain(param.name);

    const from = get_fresh_counter_value();
    const t = fresh_var(); // the value's var, unified with the parameter
    sub.bind(t.name, param);

    const poly = generalize(t, env, sub, from);

    expect(poly.vars).toHaveLength(1);
    expect(var_name(poly.type)).toBe(poly.vars[0]);
    expect(var_name(poly.type)).not.toBe(param.name);
  });

  it("resolves compounds to their concrete form when fully determined", () => {
    const sub = new Substitution();
    const from = get_fresh_counter_value();
    const t = fresh_var();
    sub.bind(t.name, create_type("int"));
    const poly = generalize(create_type("array", [t]), new Map(), sub, from);
    expect(poly.vars).toEqual([]);
    expect(poly.type).toEqual(create_type("array", [create_type("int")]));
  });
});

describe("instantiate_binding", () => {
  beforeEach(() => {
    reset_fresh_vars();
  });

  it("gives each read an independent instance", () => {
    const sub = new Substitution();
    const declared = variable("T0");
    const binding = create_binding({ vars: [declared.name], type: compound("f", [declared, declared]) }, true);

    const a = instantiate_binding(binding, sub) as Compound;
    const b = instantiate_binding(binding, sub) as Compound;

    expect(var_name(a.args[0])).not.toBe(var_name(b.args[0]));
    expect(var_name(a.args[0])).not.toBe(declared.name);
    // the binding's stored type is untouched
    expect((binding.poly.type as Compound).args.map(var_name)).toEqual([declared.name, declared.name]);
  });

  it("passes monomorphic types through unchanged", () => {
    const sub = new Substitution();
    const binding = create_binding({ vars: [], type: create_type("array", [create_type("int")]) }, true);
    expect(instantiate_binding(binding, sub)).toEqual(create_type("array", [create_type("int")]));
  });
});
