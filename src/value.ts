import { CallFrame, Environment, Interpreter, Thread } from "./interpreter";
import { BlockStatementNode } from "./parser/nodes/statements";

export abstract class Value {
  abstract to_string(): string;

  /** Value equality for `==`/`!=`: primitives compare by value, everything else by reference identity. */
  equals(other: Value): boolean {
    if (this instanceof NumberValue) return other instanceof NumberValue && this.value === other.value;
    if (this instanceof StringValue) return other instanceof StringValue && this.value === other.value;
    if (this instanceof BooleanValue) return other instanceof BooleanValue && this.value === other.value;
    if (this instanceof NullValue) return other instanceof NullValue;
    return this === other;
  }
}

/** Falsy values: null, false and 0; everything else is truthy. */
export function is_truthy(value: Value): boolean {
  if (value instanceof NullValue) return false;
  if (value instanceof BooleanValue) return value.value;
  if (value instanceof NumberValue) return value.value !== 0;
  return true;
}

export class NumberValue extends Value {
  constructor(public readonly value: number) {
    super();
  }

  to_string() {
    return this.value.toString();
  }
}

export class StringValue extends Value {
  constructor(public readonly value: string) {
    super();
  }

  to_string() {
    return this.value;
  }
}

export class BooleanValue extends Value {
  constructor(public readonly value: boolean) {
    super();
  }

  to_string() {
    return this.value.toString();
  }
}

export class NullValue extends Value {
  to_string() {
    return "null";
  }
}

export class ObjectValue extends Value {
  private readonly properties: Map<string, Value>;

  constructor(properties?: [string, Value][]) {
    super();
    this.properties = new Map(properties ?? []);
  }

  get(key: string): Value {
    if (!this.properties.has(key)) throw new Error(`No value for key "${key}"`);
    return this.properties.get(key)!;
  }

  set(key: string, value: Value): void {
    this.properties.set(key, value);
  }

  to_string(): string {
    const entries = [...this.properties.entries()].map(([k, v]) => `${k}: ${v.to_string()}`);
    return `{${entries.join(", ")}}`;
  }
}

export class ArrayValue extends Value {
  private readonly items: Value[];

  constructor(items?: Value[]) {
    super();
    this.items = [...(items ?? [])];
  }

  private check_index(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length)
      throw new Error(`Index ${index} out of bounds for array of length ${this.items.length}`);
  }

  get(index: number): Value {
    this.check_index(index);
    return this.items[index];
  }

  set(index: number, value: Value): void {
    this.check_index(index);
    this.items[index] = value;
  }

  to_string(): string {
    return `[${this.items.map((v) => v.to_string()).join(", ")}]`;
  }
}

export interface BuiltinContext {
  thread: Thread;
  interpreter: Interpreter;
}

export abstract class CallableValue extends Value {}

export class BuiltInFunctionValue extends CallableValue {
  constructor(
    public readonly name: string,
    public readonly fn: (args: Value[], ctx: BuiltinContext) => Value,
  ) {
    super();
  }

  call(argument_list: Value[], ctx: BuiltinContext): Value {
    return this.fn(argument_list, ctx);
  }

  to_string() {
    return `<built-in function: ${this.name}>`;
  }
}

export class BuiltInAsyncFunctionValue extends CallableValue {
  constructor(
    public readonly name: string,
    public readonly fn: (args: Value[], ctx: BuiltinContext) => Promise<Value>,
  ) {
    super();
  }

  call(argument_list: Value[], ctx: BuiltinContext, k: (value: Value) => void) {
    const promise = new PromiseValue(true);
    k(promise);
    this.fn(argument_list, ctx).then((v) => promise.resolve(v));
  }

  to_string() {
    return `<built-in async function: ${this.name}>`;
  }
}

export const print_fn = new BuiltInFunctionValue("print", (args: Value[]) => {
  console.log(args.map((a) => a.to_string()).join(", "));
  return new BooleanValue(true);
});

export const resolve_fn = new BuiltInAsyncFunctionValue("resolve", async (args: Value[]) => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return new NumberValue(3);
});

export class FunctionValue extends CallableValue {
  constructor(
    public readonly name: string,
    public readonly base_environment: Environment,
    public readonly is_async: boolean,
    public readonly parameter_list: string[],
    public readonly body: BlockStatementNode,
  ) {
    super();
  }

  call(thread: Thread, caller_frame: CallFrame, args: Value[], interpreter: Interpreter, k: (value: Value) => void) {
    const match_arity = this.parameter_list.length === args.length;
    if (!match_arity)
      throw new Error(`Function ${this.name} expects ${this.parameter_list.length} argument(s), got ${args.length}.`);
    const forked_environment = this.base_environment.fork();
    this.parameter_list.forEach((param, i) => forked_environment.add_key(param, args[i]));

    if (this.is_async == false) {
      // execute sync function call
      const frame = new CallFrame(this.body.statements.get_items(), forked_environment, false);
      frame.parent = caller_frame;
      frame.on_frame_done = k;
      thread.call_frame = frame;

      interpreter.step_frame(thread);
    } else {
      // execute async function call
      const frame = new CallFrame(this.body.statements.get_items(), forked_environment, true);
      const child = new Thread(interpreter, thread, frame, `T${interpreter.next_thread_id++}`);
      frame.on_frame_done = (value: Value) => child.complete_thread(value);

      const promise = new PromiseValue(false);
      child.promise = promise;
      interpreter.threads.push(child);
      k(promise);
    }
  }

  to_string() {
    return `<${this.is_async ? "async " : ""}function: ${this.name}>`;
  }
}

export class PromiseValue extends Value {
  public resolved: Value | null = null;
  public waiters: Thread[] = [];

  constructor(public readonly internally_resolved: boolean) {
    super();
  }

  is_resolved(): boolean {
    return this.resolved !== null;
  }

  resolve(value: Value): void {
    if (this.resolved !== null) return;

    // wake up all threads waiting on this promise to resolve
    this.resolved = value;
    for (const waiter of this.waiters) waiter.unblock();
    this.waiters = [];
  }

  to_string(): string {
    return this.is_resolved() ? `<promise: ${this.resolved!.to_string()}>` : "<unresolved promise>";
  }
}
