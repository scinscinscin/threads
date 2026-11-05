# Threads

A small imperative language with user-mode cooperative threads, written in
TypeScript with no build step. Programs are `.lol` files that are first
**statically typechecked** (Hindley-Milner inference with optional
annotations, type aliases, and user-defined type constructors) and then run
under a deterministic cooperative scheduler. There is no compiler, no event
loop, and no JavaScript `Promise` - concurrency is a manual `while` loop over
user-mode threads.

## Quick start

```sh
yarn install

yarn example                     # run example_program.lol
yarn start [file.lol]            # run any .lol file
yarn start file.lol --debug-types  # also print each committed type (stderr)

yarn test                        # vitest suite (typechecker units + end-to-end programs)
yarn typecheck                   # tsc --noEmit
```

The `examples/` directory contains runnable programs: `type_aliases.lol`,
`async.lol`, `closures.lol`, `objects.lol`, `loops.lol`, and more.

## Features

### Language

- **Values:** integers (no floats), double-quoted strings, booleans, `null`,
  arrays (`[1, 2]`, indexed access `a[0]`), and objects (`{x: 1, y: 2}`,
  dot access `p.x`).
- **Operators:**
  - arithmetic: `+` (overloaded: int + int, str + str), `-`, `*`, `/`
    (integers; division by zero is an error)
  - equality: `==`, `!=` (any two values)
  - comparison: `<`, `>`, `<=`, `>=` (integers, yield bool)
  - logic: `&&`, `||` (short-circuiting; both sides must share a type, since
    the result is one of the operands)
  - unary: `-`, `!`, and `await`
- **Statements:** `let` declarations (with or without initializer, with or
  without a type annotation), function expressions
  (`function(p): Ret { ... }`, plus `async function`), `if`/`else`, `for`,
  `while`, `do`/`while`, `break`/`continue` (both optionally labeled),
  `return`, and bare blocks `{ ... }` with block scope.
- **Closures:** a function captures the environment at its *definition site*.
  There is no hoisting: a name is usable only after its declaration statement
  has executed.

### Concurrency

- **User-mode cooperative threads.** The interpreter is a manual loop over a
  list of `Thread`s (the program body runs on `main`; each `async` call
  spawns a new thread labeled `T1`, `T2`, ...). Sync calls run inline on the
  caller's thread.
- **Run-until-blocked scheduling.** Each `tick()` walks threads in creation
  order and runs each runnable thread until it blocks - not round-robin. A
  thread blocks when it `await`s an unresolved promise (it parks its resume
  continuation and registers itself as a waiter on the promise). An `async`
  call never blocks its caller: the call spawns the thread and hands its
  promise back immediately; the caller only blocks if it `await`s that
  promise. If a tick makes no progress, every remaining thread is
  promise-blocked and the run fails with a `Deadlock` error listing their
  labels.
- **Promises** are a custom runtime class, not JavaScript promises. A promise
  resolves when its thread's body frame completes (a body that falls off the
  end resolves with `null`); `resolve()` flips all waiters back to runnable,
  and a woken thread runs when the next `tick()` reaches it. `await` on a
  non-promise passes the value through unchanged; `await` in a sync function
  is a runtime error (the top-level program body is async, so top-level
  `await` works).
- **Builtins:** `print` (prints its arguments, returns `true`) and `resolve`
  (an async demo builtin that resolves with `3` after a second). While a
  thread waits on a builtin that uses a real JavaScript timer, the scheduler
  yields to the host event loop and resumes when the builtin's promise
  resolves - the only point at which host async leaks in.

### Type system

- **Hindley-Milner inference** with let-generalization: unannotated bindings
  get a polytype, and each read instantiates it independently.
- **Optional annotations** on `let` declarations, for-loop initializers, and
  function parameters/returns (`function(p: T): R { ... }`). Annotated
  declarations are checked and stay monomorphic; async functions annotate the
  *inner* return type (it is auto promise-wrapped).
- **Type expressions:** the built-in names `int`, `bool`, `void`, `str`,
  `null`, `any`; parametric `Promise<T>` (also `promise<T>`); repeatable
  array types `T[]`; function types `(T1, ..., Tn) => R`; and object types
  `{a: T; b: T}` (identifier or string-literal keys, `;`-delimited).
- **Type aliases:** `type Name = <type expr>:` binds a name in the type
  namespace (a runtime no-op). Aliases are block-scoped and shadowable like
  lets, may chain, and may reference aliases declared later at the top level.
- **User-defined type constructors:** `type Name<A, B> = <type expr using A
  and B>:` defines a parameterized type. The body is lowered once at
  declaration with the parameters bound to fresh type variables; each use
  `Name<T1, T2>` substitutes its arguments for those variables. A bare use
  of the constructor name is a type error, argument counts are arity-checked,
  and parameter names may not duplicate each other or shadow a built-in type
  name.
- **Positioned errors.** Type failures are `TypeCheckError`s reported at the
  offending token's `line:column`. `--debug-types` prints, to stderr, the
  polytype each top-level declaration committed to and each top-level alias's
  definition.

## How typechecking works

A program goes through three phases in `src/index.ts`: the slex DFA lexer
tokenizes it, a sparse LR(1) parser (grammar in `src/grammar.txt`, driver and
reducers in `src/parser.ts`, AST node classes in `src/parser/nodes/`) builds
the AST, and the
typechecker in `src/typechecker/` checks it before the `Interpreter` ever
runs. The typechecker never touches the runtime - declarations like `type`
aliases are runtime no-ops.

**Types are terms.** A type is a `Term`: an atom (`int`), a type variable
(`t3`), or a compound term (`promise(int)`, `array(int)`, `f(int, bool)`,
`obj(x(int), y(int))`). Checking is unification of terms with a trail-based
substitution (`unify.ts`): bindings are recorded on a trail so a whole
branch can be undone with `unmark`. Backtracking matters in practice for
`+`, which is overloaded int/str and tries both readings.

**The inference walk.** Expressions implement `infer(state)` (return the
inferred term) and `check(type, state)`; statements implement
`typecheck(state)`. In each case `state` is a single object -
`ExprTypecheckState` (`{ e, e_all, sub, ctx }`, with `e_all` optional) for
expressions and `TypecheckState` (`{ e, e_all, sub, r, ctx }`) for
statements - destructured by each implementation for the fields it uses.
Evaluation is continuation-passing, mirroring the runtime. `e` is the *live*
environment (bindings processed so far); `e_all` is the *registered*
environment (every declaration in scope, unprocessed ones as placeholders);
`sub` is the pass's accumulating substitution; `r` is the enclosing return
type; `ctx` is the pass's context.

**Let-polymorphism.** At a `let` (or assignment to a mutable binding), the
inferred type is run through `generalize`: variables minted during that
expression's inference and free of the environment become declared variables
of the polytype. Every *read* of the binding calls `instantiate_binding`,
which rebinds the declared variables to fresh ones, so `let f = function(x)
{ return x; }` is `forall a. a -> a` in effect. A subtlety: variables linked
to another *unprocessed* binding's placeholder are kept undeclared so the
constraints that binding adds later survive generalization.

**Deferred function bodies, two-phase driver.** A function body is checked
against the *registered* environment, not the live one, so a body may
reference declarations that come later in the scope (closures see the live
scope at call time). The driver (`typecheck()` in `typechecker/index.ts`)
implements this in two phases: a pre-scan registers every top-level `let` in
`e_all` - annotated lets get their annotation, unannotated lets get a fresh
placeholder variable - and pre-registers every top-level alias (names first,
then records, so aliases may reference each other in any order). The ordered
walk then processes statements in source order, committing each let's
inferred type to its placeholder. A forward reference in an *initializer* is
still an error (the runtime crashes there too); only *bodies* may look
forward.

**Annotations.** Type expressions parse into a `TypeExpressionNode` tree
(`src/parser/nodes/types.ts`); each node lowers itself to a `Term` via
`lower(ctx)` at typecheck time, so unknown names become positioned errors at
the annotation. An async function's return annotation is wrapped in
`promise(...)` automatically.

**Aliases and constructors.** All per-pass type-namespace state lives in a
`TypecheckContext` (a fresh-variable generator plus a block-scoped
`AliasTable`), instantiated at the root of the pass and threaded through as
the single `ctx` - so separate passes run independently. Name resolution is
one path: `AliasTable.resolve` checks the alias scopes (innermost first)
before the built-in name table, so alias handling is transparent to the
`lower()` implementations. A plain alias's target is lowered when its record
is computed; a type *constructor's* body is lowered once at declaration with
its parameters bound to fresh type variables, and each use substitutes the
argument terms for those variables (`apply_user_constructor`). Because
lowering happens under a re-entrancy guard, circular definitions (including
through constructor bodies) are positioned errors. Blocks push/pop an alias
scope just like value scope, so aliases - and constructors - shadow
block-locally.

**Reporting.** Failures are positioned `TypeCheckError`s (line:column).
`--debug-types` renders each top-level declaration's committed polytype (via
`show_polytype`) and each top-level alias, printing e.g.
`type Pair<A, B> = obj(first: A, second: B)` for a constructor.

## Project layout

```
src/
  index.ts            entrypoint: parse, typecheck, run; --debug-types
  lexer.ts            slex DFA tokenizer; TokenType
  grammar.txt         the LR(1) grammar
  parser.ts           parser driver + reducers (AST node factories)
  interpreter.ts      Environment, CallFrame, LoopFrame, Thread, Interpreter
  value.ts            runtime values, FunctionValue, PromiseValue, builtins
  parser/nodes/       AST nodes: base, statements, expressions, types
  typechecker/
    index.ts          TypecheckContext, AliasTable, generalize/instantiate,
                      two-phase typecheck() driver, error type
    ast.ts            Term (atom/var/compound), show_type
    unify.ts          trail substitution, unify_write, apply_term
    intrinsics.ts     builtin signatures (print, resolve)
test/                 vitest: typechecker units + end-to-end parse+typecheck
examples/             runnable .lol programs
```

## Development notes

- No build step: everything runs through `tsx`; `tsc --noEmit` is the
  typecheck. There is no linter - verification is `yarn typecheck` +
  `yarn test` + running the examples and checking their output.
- CI (`.github/workflows/ci.yml`) runs typecheck, tests, and the example on
  push to main.
- Known gaps: the grammar admits `class` declarations, but the parser
  reports them as not implemented; numbers are integers only; the only
  builtins are `print` and `resolve`.
