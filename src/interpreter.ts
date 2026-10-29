import type { StatementNode } from "./parser";
import { NullValue, PromiseValue, Value, print_fn, resolve_fn } from "./value";

export class Environment {
  public map: Map<string, Value> = new Map();

  private constructor(public readonly parent: Environment | null = null) {}
  public static create_global_environment() {
    const g = new Environment();
    g.add_key("print", print_fn);
    g.add_key("resolve", resolve_fn);
    return g;
  }

  get(key: string): Value {
    if (this.map.has(key)) return this.map.get(key)!;
    if (this.parent !== null) return this.parent.get(key);
    throw new Error(`No value for ${key}`);
  }

  add_key(key: string, value: Value) {
    this.map.set(key, value);
  }

  set_key(key: string, value: Value) {
    if (this.map.has(key)) this.map.set(key, value);
    else if (this.parent !== null) this.parent.set_key(key, value);
    else throw new Error(`No existing value for ${key}`);
  }

  fork() {
    return new Environment(this);
  }
}

export class CallFrame {
  public parent: CallFrame | null = null;
  public statements: StatementNode[];
  public counter = 0;
  public environment: Environment;
  public is_async_context: boolean;

  /** Frames in which a `return` statement terminates this frame (function bodies, program body). */
  public captures_return = true;
  /** Invoked with the frame's return value when the frame completes; null for block frames. */
  public on_frame_done: ((value: Value) => void) | null = null;

  public constructor(statements: StatementNode[], environment: Environment, is_async_context: boolean) {
    this.statements = statements;
    this.environment = environment;
    this.is_async_context = is_async_context;
  }

  next_statement(): StatementNode | null {
    if (this.counter >= this.statements.length) return null;
    return this.statements[this.counter++];
  }
}

export type ThreadStatus = "not_blocked" | "blocked" | "blocked_on_internal_promise" | "finished";

export class Thread {
  public status: ThreadStatus = "not_blocked";
  /** The promise this thread resolves when its body frame completes; null for sync-threads */
  public promise: PromiseValue | null = null;

  /** The promise this thread is currently blocked awaiting; null otherwise. */
  public blocked_on: PromiseValue | null = null;
  /** Completes the in-flight statement after the thread wakes from a blocked await. */
  public pending: (() => void) | null = null;

  constructor(
    public interpreter: Interpreter,
    public readonly parent: Thread | null,
    public call_frame: CallFrame,
    public readonly label: string,
  ) {}

  suspended_or_ok(): StatementOutcome {
    return this.status === "not_blocked" ? { kind: "ok" } : { kind: "suspended" };
  }

  // this function is called whenever the root call frame of a thread completes
  // either main thread or a thread created by an async function invocation
  complete_thread(value: Value): void {
    this.status = "finished";
    if (this.promise !== null) this.promise.resolve(value);
  }

  unblock(): void {
    this.status = "not_blocked";
    this.blocked_on = null;

    if (!this.interpreter.interpreter_is_running) this.interpreter.run();
  }
}

type StatementOutcome = { kind: "ok" } | { kind: "return"; value: Value } | { kind: "suspended" };

export class Interpreter {
  public global_environment: Environment;
  public main_thread: Thread;
  public threads: Thread[] = [];

  public next_thread_id = 1;

  public constructor(root_statements: StatementNode[]) {
    this.global_environment = Environment.create_global_environment();

    const root_frame = new CallFrame(root_statements, this.global_environment, true);
    this.main_thread = new Thread(this, null, root_frame, "main");
    root_frame.on_frame_done = (value: Value) => this.main_thread.complete_thread(value);
    this.threads.push(this.main_thread);
  }

  /** Run the program until every thread has finished. Throw an error if can't progress any further. */
  interpreter_is_running = false;
  public async run(): Promise<void> {
    if (this.interpreter_is_running) return;
    this.interpreter_is_running = true;

    runtime: while (this.threads.some((t) => t.status !== "finished")) {
      if (!this.tick()) {
        // If there is a thread waiting on an internal promise, shut down the interpreter
        // The interpreter will be awaken when it resolvees and the blocked thread is unblocked
        const waiting = this.threads.filter((t) => t.status === "blocked_on_internal_promise");
        if (waiting.length > 0) break runtime;

        // If there are no threads waiting on an internal promise, throw a deadlock error
        const stuck = this.threads.filter((t) => t.status === "blocked");
        throw new Error(
          `Deadlock: ${stuck.map((t) => t.label).join(", ")} blocked on promises that will never resolve.`,
        );
      }
    }

    this.interpreter_is_running = false;
  }

  /** Advance every sleeping or runnable thread by one scheduling unit. */
  public tick(): boolean {
    let progressed = false;

    for (const thread of this.threads) {
      if (thread.status === "not_blocked") {
        this.run_until_blocked(thread);
        progressed = true;
      }
    }

    return progressed;
  }

  private run_until_blocked(thread: Thread): void {
    while (thread.status === "not_blocked") {
      if (thread.pending === null) this.step_frame(thread);
      else {
        const pending = thread.pending;
        thread.pending = null;
        pending();
      }
    }
  }

  /**
   * Execute the top frame's statements until the frame is done, the thread blocks
   * (sleep) or suspends (await), or a `return` unwinds an enclosing frame.
   */
  public step_frame(thread: Thread): void {
    for (;;) {
      if (thread.status !== "not_blocked") return;
      const frame = thread.call_frame;
      const stmt = frame.next_statement();

      // Reached the end of the call frame, return with a null value
      if (stmt === null) return this.finish_frame(thread, frame, new NullValue());

      const result = stmt.eval(thread, frame, this);
      if (result.kind === "return") {
        // roll back the callframe to one that captures returns
        let target = frame;
        while (!target.captures_return) target = target.parent!;

        this.finish_frame(thread, target, result.value);
        return;
      } else if (result.kind === "suspended") return;
    }
  }

  // called whenever a callframe is returned
  private finish_frame(thread: Thread, frame: CallFrame, value: Value): void {
    const on_done = frame.on_frame_done;
    frame.on_frame_done = null;
    if (frame.parent !== null) thread.call_frame = frame.parent;
    if (on_done !== null) on_done(value);
  }
}
