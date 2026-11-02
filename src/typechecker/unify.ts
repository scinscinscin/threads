import { atom, compound, is_compound, is_var, is_var_name, Term, Var, variable } from "./ast.js";

/** A substitution as an immutable snapshot (Map of variable name to term). */
export type Subst = Map<string, Term>;
export const create_subst = (): Subst => new Map();

/**
 * A substitution with a trail, giving O(1) bind and O(undone) backtrack.
 * This is the classical Prolog implementation: bindings are recorded on a
 * trail so a whole branch of the search can be undone with `unmark`.
 */
export class Substitution {
  public map = new Map<string, Term>();
  private trail: Array<[string, Term | undefined]> = [];

  /** Current trail length, to be used as a backtrack point. */
  mark(): number {
    return this.trail.length;
  }

  /** Undo all bindings made after `m`. */
  unmark(m: number): void {
    while (this.trail.length > m) {
      const entry = this.trail.pop()!;
      const prev = entry[1];
      if (prev === undefined) this.map.delete(entry[0]);
      else this.map.set(entry[0], prev);
    }
  }

  /** Bind a variable to a term (recording the previous binding on the trail). */
  bind(name: string, term: Term): void {
    this.trail.push([name, this.map.get(name)]);
    this.map.set(name, term);
  }

  /** A read-only copy of the current bindings. */
  fork(): Subst {
    return new Map(this.map);
  }
}

/** Follow the binding chain of a term under a snapshot substitution. */
export function resolve(t: Term, env: Subst): Term {
  let cur = t;
  let hops = 0;

  while (is_var(cur)) {
    if (++hops > 10_000) throw new Error("variable binding chain too long");
    const v = env.get(cur.name);
    if (v === undefined) return cur;
    cur = v;
  }

  return cur;
}

// Returns true if variable v is used inisde term t
function occurs_check(v: Var, t: Term, sub: Substitution): boolean {
  const cur = resolve(t, sub.map);
  if (cur.kind === "atom") return false;
  if (cur.kind === "var") return cur.name === v.name;

  return cur.args.some((a) => occurs_check(v, a, sub));
}

/**
 * Unify two terms, extending `sub` destructively.
 * Returns true on success; on failure `sub` is restored to its previous
 * state. Includes an occurs check, so `X = f(X)` fails instead of looping.
 */
export function unify_write(a: Term, b: Term, sub: Substitution): boolean {
  const ra = resolve(a, sub.map);
  const rb = resolve(b, sub.map);

  // variables first: bind, or reject on the occurs check
  if (ra.kind === "var") {
    if (rb.kind === "var" && ra.name === rb.name) return true;

    if (occurs_check(ra, rb, sub)) return false;
    sub.bind(ra.name, rb);
    return true;
  }

  if (rb.kind === "var") {
    if (occurs_check(rb, ra, sub)) return false;
    sub.bind(rb.name, ra);
    return true;
  }

  if (ra.kind === "atom" || rb.kind === "atom") {
    // two atoms are the same if they share the same name
    return ra.kind === "atom" && rb.kind === "atom" && ra.name === rb.name;
  }

  // if they aren't both compound terms, return false
  if (ra.kind !== "compound" || rb.kind !== "compound") return false;
  if (ra.args.length !== rb.args.length) return false;

  // Mark the current location of the substitution so it can be restored if substitution fails
  const m = sub.mark();

  if (ra.functor !== rb.functor) {
    // A variable in functor position is a "dynamic functor" (a Prolog
    // extension): it unifies with any functor name, so the clause
    // `P(X) :- r(X).` also serves calls of `p/1`.
    const fa = is_var_name(ra.functor) ? resolve(variable(ra.functor), sub.map) : atom(ra.functor);
    const fb = is_var_name(rb.functor) ? resolve(variable(rb.functor), sub.map) : atom(rb.functor);

    if (fa.kind === "var" && (fb.kind === "var" || fb.kind === "atom")) sub.bind(fa.name, fb);
    else if (fb.kind === "var" && fa.kind === "atom") sub.bind(fb.name, fa);
    else if (fa.kind === "atom" && fb.kind === "atom" && fa.name === fb.name) {
      // already the same functor under the current bindings
    } else {
      sub.unmark(m);
      return false;
    }
  }

  // Object types match properties by name, not position: the runtime
  // ObjectValue is a keyed map, and key order is not semantically significant.
  // Both sides must name the same set of keys, and corresponding types unify.
  if (ra.functor === "obj" && rb.functor === "obj") {
    // entries are always `compound(key, [type])` by construction; filter keeps
    // TypeScript happy about the narrowing
    const props_a = ra.args.filter(is_compound);
    const props_b = rb.args.filter(is_compound);

    for (const prop of props_a) {
      /** .functor is the name of the property, try to find a candidate from A to B */
      const candidate = props_b.find((e) => e.functor === prop.functor);

      /** if property does not exist OR failed to unify types of both properties, reject */
      if (candidate === undefined || !unify_write(prop.args[0], candidate.args[0], sub)) {
        sub.unmark(m);
        return false;
      }
    }

    for (const prop of props_b) {
      if (props_a.find((e) => e.functor === prop.functor) === undefined) {
        sub.unmark(m);
        return false;
      }
    }

    return true;
  }

  // Same functions, unify arguments.
  // If failed, rollback and return false
  for (let i = 0; i < ra.args.length; i++) {
    if (!unify_write(ra.args[i], rb.args[i], sub)) {
      sub.unmark(m);
      return false;
    }
  }

  return true;
}

/**
 * Pure unification: return an extended copy of the substitution,
 * or null when the terms cannot be unified.
 */
export function unify(a: Term, b: Term, env: Subst): Subst | null {
  const sub = new Substitution();
  for (const [k, v] of env) sub.bind(k, v);
  if (!unify_write(a, b, sub)) return null;
  return sub.fork();
}

/** Create new compound term that substitutes all variables based on env */
export function apply_term(term: Term, subst: Subst): Term {
  const resolved = resolve(term, subst);

  if (resolved.kind !== "compound") return resolved;
  return compound(
    resolved.functor,
    resolved.args.map((a) => apply_term(a, subst)),
  );
}
