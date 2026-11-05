/** The term encoding used by the type system: atoms (type names like `int`),
 *  type variables, and compounds (`promise(int)`, `f(p, R)`, `obj(key(T), ...)`). */

export type Term = Atom | Var | Compound;
export type Atom = { kind: "atom"; name: string };
export type Var = { kind: "var"; name: string };
export type Compound = { kind: "compound"; functor: string; args: Term[] };

export const atom = (name: string): Atom => ({ kind: "atom", name });

export const variable = (name: string): Var => ({ kind: "var", name });
export const is_var = (t: Term): t is Var => t.kind === "var";

export const compound = (functor: string, args: Term[]): Compound => ({ kind: "compound", functor, args });
export const is_compound = (t: Term): t is Compound => t.kind === "compound";

/** True when a name lexes as a variable (uppercase letter or underscore). */
export function is_var_name(name: string): boolean {
  const c = name[0];
  return c === "_" || (c >= "A" && c <= "Z");
}

export function show_term(t: Term): string {
  switch (t.kind) {
    case "atom":
    case "var":
      return t.name;
    case "compound":
      return `${t.functor}(${t.args.map(show_term).join(", ")})`;
  }
}

export function show_type(t: Term): string {
  if (t.kind === "compound" && t.functor === "f" && t.args.length >= 2) {
    // f(p1, ..., pn, R): all but the last argument are parameters
    const params = t.args.slice(0, -1).map(show_type);
    return `${params.join(", ")} -> ${show_type(t.args[t.args.length - 1])}`;
  }
  if (t.kind === "compound" && t.functor === "obj") {
    // obj(key(T), ...): each argument is a property name applied to its type
    const props = t.args.map((a) => (a.kind === "compound" ? `${a.functor}: ${show_type(a.args[0])}` : show_type(a)));
    return `obj(${props.join(", ")})`;
  }
  return show_term(t);
}
