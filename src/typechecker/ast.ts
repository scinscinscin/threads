/**
 * Encoding of a first order logic language
 */

export type Term = Atom | Var | Compound;
export type Atom = { kind: "atom"; name: string };
export type Var = { kind: "var"; name: string };
export type Compound = { kind: "compound"; functor: string; args: Term[] };

export const atom = (name: string): Atom => ({ kind: "atom", name });
export const is_atom = (t: Term): t is Atom => t.kind === "atom";

export const variable = (name: string): Var => ({ kind: "var", name });
export const is_var = (t: Term): t is Var => t.kind === "var";

export const compound = (functor: string, args: Term[]): Compound => ({ kind: "compound", functor, args });
export const is_compound = (t: Term): t is Compound => t.kind === "compound";

/** True when a name lexes as a variable (uppercase letter or underscore). */
export function is_var_name(name: string): boolean {
  const c = name[0];
  return c === "_" || (c >= "A" && c <= "Z");
}

/**
 * A goal in a clause body or in a query:
 *   - call: a predicate invocation, e.g. `father(tom, bob)` or `foo`
 *   - eq:   a unification test, e.g. `X = f(Y)`
 *   - not:  negation as failure, e.g. `\+ father(ann, tom)`
 *   - or:   disjunction; each branch is a conjunction of goals,
 *           e.g. `a ; b, c` is one or-goal with branches [[a], [b, c]]
 */
export type Goal =
  | { kind: "call"; term: Term }
  | { kind: "eq"; left: Term; right: Term }
  | { kind: "not"; goal: Goal }
  | { kind: "or"; branches: Goal[][] };

/** A clause: `Head :- Body.` (a fact when the body is empty). */
export interface Clause {
  head: Term;
  body: Goal[];
  source: string;
}

/**
 * Collect the names of the named variables occurring in a list of goals,
 * in order of first appearance. Anonymous variables (leading `_`) are skipped.
 */
export function goal_vars(goals: Goal[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visitTerm = (t: Term): void => {
    if (t.kind === "var") {
      if (t.name.startsWith("_")) return;
      if (!seen.has(t.name)) {
        seen.add(t.name);
        out.push(t.name);
      }
    } else if (t.kind === "compound") {
      // a variable in functor position (e.g. `P(X)`) is a variable too
      if (is_var_name(t.functor)) visitTerm(variable(t.functor));
      for (const a of t.args) visitTerm(a);
    }
  };

  const visitGoal = (g: Goal): void => {
    switch (g.kind) {
      case "call":
        visitTerm(g.term);
        break;
      case "eq":
        visitTerm(g.left);
        visitTerm(g.right);
        break;
      case "not":
        visitGoal(g.goal);
        break;
      case "or":
        for (const branch of g.branches) for (const g2 of branch) visitGoal(g2);
        break;
    }
  };

  for (const g of goals) visitGoal(g);
  return out;
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
