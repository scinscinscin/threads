# AGENTS.md

"Threads" (`.lol` files): a small language with user-mode cooperative threads. TypeScript, no build step (run via `tsx`), yarn classic (yarn.lock). Node >= 18.

## Commands

- `yarn install`
- `yarn example` / `yarn demo` - run `example_program.lol` / `concurrency_demo.lol`
- `yarn start [file.lol]` - run any `.lol` file (defaults to `example_program.lol`)
- `yarn typecheck` - `tsc --noEmit`
- `yarn test` - vitest suite (`test/*.test.ts`): typechecker units (create_type, unify, generalize/instantiate) plus end-to-end parse+typecheck programs
- CI (`.github/workflows/ci.yml`) runs typecheck, tests, and the example on push to main
- There is no linter. Verification = typecheck + tests + running the demo programs and checking their output.

## Architecture (all in `src/`)

- `index.ts` - entrypoint: reads `.lol` path from argv, parses, runs the `Interpreter`
- `lexer.ts` - slex DFA tokenizer; `TokenType` enum
- `parser.ts` - sparse LR(1) parser + AST node classes + `reducers` map
- `interpreter.ts` - `Environment`, `CallFrame`, `Thread`, `Interpreter` scheduler
- `value.ts` - runtime values, `FunctionValue`/`PromiseValue`, builtins
- `typechecker/` - static Hindley-Milner typechecker (no annotations in the grammar): `index.ts` (type registry via `create_type`, `Binding`/generalization, `typecheck()` driver), `ast.ts` (`Term` = atom/var/compound, `show_type`), `unify.ts` (trail substitution), `intrinsics.ts` (builtin signatures)

## Runtime & concurrency

There is no event loop and no JavaScript `Promise` - the interpreter is a manual `while` loop (`Interpreter.run()`) over a list of user-mode `Thread`s, and `PromiseValue` is a custom class. Everything below is driven by `tick()`.

**Evaluation is continuation-passing (CPS).** Statements implement `eval(thread, frame, interpreter): StatementOutcome` (`{kind: "ok" | "return" | "suspended"}`); expressions implement `eval(thread, frame, interpreter, k)` and call `k(value)`. A node that may block returns `"suspended"` after putting the thread to sleep. Follow these exact signatures when adding a node.

**Scheduling is "run until blocked," not round-robin.** Each `tick()` walks threads in creation order (`main`, `T1`, `T2`, ...):
- A runnable thread runs until it hits `sleep` or an unresolved `await` (many statements per tick).
- A sleeping thread only decrements its sleep counter; it wakes once its `sleep(n)` has fully counted down, and never runs in the tick it wakes.
- A thread blocked on a promise does nothing and counts as no progress.

If a tick makes no progress, every remaining thread is promise-blocked and `run()` throws `Deadlock` listing their labels.

**Two distinct blocking mechanisms** (both set `status = "blocked"`):
- `sleep(n)` sets `sleep_remaining = n` and is woken by tick decrementing. It is not a promise.
- `await <unresolved promise>` sets `blocked_on`, stores the resume continuation in `pending`, and registers the thread in `promise.waiters`; it is woken when `PromiseValue.resolve()` flips the waiter back to `not_blocked`.

**Await edge cases:** `await <non-promise>` passes through unchanged; `await <resolved promise>` returns immediately without blocking; `await` in a sync function body is a runtime error (it is only legal in async contexts). The top-level program body is async, so top-level `await` works.

**Calls:** an `async` call spawns a new `Thread` (label `T1`, `T2`, ...) and hands its promise back to the caller without blocking; the body runs on later ticks. A sync call runs inline on the caller's thread. A promise resolves when its thread's body frame completes (a function that falls off the end resolves with `null`). Wake order: `resolve()` flips waiters to `not_blocked`, but a woken thread runs only when `tick()` reaches it - so a thread created before the resolver runs next tick, while one created after runs in the same tick.

**Frames & returns:** call frames chain via `parent`. `captures_return` is true for function/program bodies and false for blocks, so `return` unwinds through blocks to the enclosing function body. `on_frame_done(value)` is the frame-completion callback (the call continuation for sync, `complete_thread` for async, `null` for blocks).

**Scoping:** environments chain via `parent`. A function call forks the *definition-site* environment (closures) and binds parameters in the fork; a block forks the current environment (block scope). Function declarations register the function when the declaration statement executes - there is no hoisting, so declare before use. The global environment provides `print` and `sleep`.

**Language surface:** builtins are only `print` and `sleep`; the only operator is `+` (number/string); numbers are integers only; strings are double-quoted (single quotes allowed inside, `\n` unescaped).
