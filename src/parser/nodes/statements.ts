import { CallFrame, Interpreter, LoopFrame, Thread } from "../../interpreter";
import { Token } from "../../lexer";
import {
  Binding,
  unify_check,
  create_binding,
  create_type,
  generalize,
  ResolvedType,
  TypecheckContext,
  TypeEnvironment,
} from "../../typechecker";
import { show_type, Term, variable } from "../../typechecker/ast";
import { resolve, Substitution } from "../../typechecker/unify";
import { is_truthy, NullValue, Value } from "../../value";
import { BaseNode, ListNode } from "./base";
import { ExpressionNode } from "./expressions";
import { TypeExpressionNode } from "./types";

type StatementOutcome =
  | { kind: "ok" }
  | { kind: "return"; value: Value }
  | { kind: "suspended" }
  | { kind: "end_frame" };

/** The state threaded through statement typechecking: `e` is the live
 *  environment (declarations already processed) that value expressions see;
 *  `e_all` is the registered environment (every declaration in scope,
 *  unprocessed ones as placeholders) that function bodies see; `sub` is the
 *  pass's substitution, `r` the enclosing return type, and `ctx` the pass's
 *  context. */
export type TypecheckState = {
  e: TypeEnvironment;
  e_all: TypeEnvironment;
  sub: Substitution;
  r: Term;
  ctx: TypecheckContext;
};

export abstract class StatementNode extends BaseNode {
  abstract execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome;
  abstract typecheck(state: TypecheckState): TypeEnvironment;
}

export class BlockStatementNode extends StatementNode {
  constructor(public readonly statements: ListNode<StatementNode>) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    const block_frame = new CallFrame(this.statements.get_items(), frame.environment.fork(), frame.is_async_context);
    block_frame.parent = frame;
    // `return` statements bypass the block frame
    block_frame.captures_return = false;
    thread.call_frame = block_frame;
    interpreter.step_frame(thread);
    return thread.suspended_or_ok();
  }

  typecheck({ e, e_all, sub, r, ctx }: TypecheckState): TypeEnvironment {
    let e2 = new Map(e);
    let e_all2 = new Map(e_all);

    // Type aliases are scoped per block just like value bindings: the block
    // gets its own alias scope, so aliases declared inside do not leak out.
    ctx.aliases.push_scope();
    try {
      for (const st of this.statements.get_items()) e2 = st.typecheck({ e: e2, e_all: e_all2, sub, r, ctx });
    } finally {
      ctx.aliases.pop_scope();
    }

    return e;
  }
}

export class VariableDeclarationNode extends StatementNode {
  constructor(
    public readonly variable_name: Token,
    public readonly type: TypeExpressionNode | null,
    public readonly value: ExpressionNode | null,
  ) {
    super();
  }

  /** The binding the typechecker driver pre-registered for this declaration
   *  (top-level only); set by `typecheck`, not the parser. */
  registered?: Binding;

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    const name = this.variable_name.lexeme;
    // `let x;` omits the initializer entirely, so the bag value is absent
    if (this.value == null) {
      frame.environment.add_key(name, new NullValue());
      return { kind: "ok" };
    }
    this.value.eval(thread, frame, interpreter, (value) => frame.environment.add_key(name, value));
    return thread.suspended_or_ok();
  }

  typecheck({ e, e_all, sub, ctx }: TypecheckState): TypeEnvironment {
    const name = this.variable_name.lexeme;
    const env2: TypeEnvironment = new Map(e);

    // an annotated declaration is checked against the annotation and stays
    // monomorphic: annotations cannot contain type variables, so there is
    // nothing to generalize
    if (this.type !== null) {
      const annotated_type = this.type.lower(ctx);
      if (this.value !== null)
        unify_check(this.value.infer({ e, sub, ctx, e_all }), annotated_type, sub, `Initializer for "${name}"`);

      if (this.registered !== undefined) {
        this.registered.poly = { vars: [], type: annotated_type };
        env2.set(name, this.registered);
      } else {
        const binding = create_binding({ vars: [], type: annotated_type }, { mutable: true });
        env2.set(name, binding);
        e_all.set(name, binding);
      }

      return env2;
    }

    // `let x;` starts as null at runtime but accepts any later assignment,
    // so it is typed with an unconstrained variable the first assignment pins
    const before = ctx.fresh.value();
    const variable_type = this.value == null ? ctx.fresh.next() : this.value.infer({ e, sub, ctx, e_all });

    // a pre-registered declaration carries a placeholder variable: commit the
    // inferred type to it so function bodies already checked against this
    // binding see the same variable. Declarations without a placeholder
    // (duplicate names, block-local lets) get a fresh binding, mirroring the
    // live environment's overwrite semantics
    if (this.registered !== undefined && this.registered.placeholder !== undefined) {
      unify_check(variable_type, variable(this.registered.placeholder), sub, `Type of "${name}"`, this.variable_name);
      this.registered.poly = generalize(variable_type, e_all, sub, before, ctx, this.registered.placeholder);
      env2.set(name, this.registered);
      return env2;
    }

    const binding = create_binding(generalize(variable_type, e_all, sub, before, ctx), { mutable: true });
    env2.set(name, binding);
    e_all.set(name, binding);
    return env2;
  }
}

/** A type alias declaration: `type Name = <type expr>:`, or a user-defined
 *  type constructor declaration: `type Name<A, B> = <type expr using A and
 *  B>:`. Purely static -- a runtime no-op that registers `Name` in the
 *  enclosing alias scope, where it resolves to the target type expression at
 *  every type position. */
export class TypeDeclarationNode extends StatementNode {
  constructor(
    public readonly name: Token,
    public readonly params: ListNode<Token> | null,
    public readonly type: TypeExpressionNode,
  ) {
    super();
  }

  /** The record the typechecker registered for this declaration (top-level
   *  only); set by the `typecheck` driver's pre-scan, not the parser. */
  registered?: ResolvedType;

  execute(): StatementOutcome {
    // Aliases live only in the typechecker's name table; no runtime effect.
    return { kind: "ok" };
  }

  typecheck({ e, ctx }: TypecheckState): TypeEnvironment {
    if (this.registered === undefined) {
      ctx.aliases.declare(this.name, this.params?.get_items() ?? null, this.type);
      this.registered = ctx.aliases.record(this.name.lexeme);
    }

    return e;
  }
}

export function is_void(t: Term, sub: Substitution): boolean {
  const r = resolve(t, sub.map);
  return r.kind === "atom" && r.name === "void";
}

export class ReturnStatementNode extends StatementNode {
  constructor(public readonly expr: ExpressionNode | null) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    // complete the return from the continuation so that a blocking expression
    // (e.g. `return await x;`) still delivers its value once the thread wakes
    if (this.expr === null) interpreter.complete_return(thread, frame, new NullValue());
    else this.expr.eval(thread, frame, interpreter, (value) => interpreter.complete_return(thread, frame, value));
    return thread.suspended_or_ok();
  }

  typecheck({ e, e_all, sub, r, ctx }: TypecheckState): TypeEnvironment {
    if (this.expr) this.expr.check(r, { e, sub, ctx, e_all });
    else if (!is_void(r, sub))
      throw new Error(`missing return value: function returns ${show_type(resolve(r, sub.map))}`);
    return e;
  }
}

export class ExpressionStatementNode extends StatementNode {
  constructor(public readonly expr: ExpressionNode) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    this.expr.eval(thread, frame, interpreter, () => {});
    return thread.suspended_or_ok();
  }

  typecheck({ e, e_all, sub, ctx }: TypecheckState): TypeEnvironment {
    this.expr.infer({ e, sub, ctx, e_all });
    return e;
  }
}

export class IfStatementNode extends StatementNode {
  constructor(
    public readonly condition: ExpressionNode,
    public readonly then_body: StatementNode,
    public readonly else_body: StatementNode | null,
  ) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    this.condition.eval(thread, frame, interpreter, (value) => {
      const body = is_truthy(value) ? this.then_body : this.else_body;
      if (body === null) return;
      body.execute(thread, frame, interpreter);
    });

    return thread.suspended_or_ok();
  }

  typecheck({ e, e_all, sub, r, ctx }: TypecheckState): TypeEnvironment {
    this.condition.check(create_type("bool"), { e, sub, ctx, e_all });
    this.then_body.typecheck({ e, e_all, sub, r, ctx });
    if (this.else_body) this.else_body.typecheck({ e, e_all, sub, r, ctx });
    return e;
  }
}

/**
 * Evaluates a loop condition. A falsy condition finishes the loop frame from
 * the continuation, so the loop also terminates correctly when the condition
 * blocks on an await. A null condition (a `for` loop without one) is always true.
 */
class LoopConditionNode extends StatementNode {
  constructor(public readonly condition: ExpressionNode | null) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    if (this.condition === null) return { kind: "ok" };

    this.condition.eval(thread, frame, interpreter, (value) => {
      if (!is_truthy(value)) interpreter.finish_frame(thread, frame, new NullValue());
    });

    return thread.suspended_or_ok();
  }

  typecheck({ e, e_all, sub, ctx }: TypecheckState): TypeEnvironment {
    if (this.condition) this.condition.check(create_type("bool"), { e, sub, ctx, e_all });
    return e;
  }
}

function run_loop(
  thread: Thread,
  frame: CallFrame,
  interpreter: Interpreter,
  statements: StatementNode[],
  rewind_index: number,
  continue_index: number,
  label: string | null,
): StatementOutcome {
  const loop_frame = new LoopFrame(
    statements,
    frame.environment.fork(),
    frame.is_async_context,
    rewind_index,
    continue_index,
    label,
  );
  loop_frame.parent = frame;
  // a `return` inside a loop exits the enclosing function, not the loop
  loop_frame.captures_return = false;
  thread.call_frame = loop_frame;
  interpreter.step_frame(thread);
  return thread.suspended_or_ok();
}

/** Walks the frame chain of the given thread to find the target loop frame. */
function find_loop_frame(thread: Thread, label: string | null): LoopFrame | null {
  let current: CallFrame | null = thread.call_frame;
  while (current !== null) {
    if (current instanceof LoopFrame && (label === null || current.label === label)) return current;
    current = current.parent;
  }
  return null;
}

export class WhileStatementNode extends StatementNode {
  constructor(
    public readonly label: string | null,
    public readonly condition: ExpressionNode,
    public readonly body: StatementNode,
  ) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    return run_loop(thread, frame, interpreter, [new LoopConditionNode(this.condition), this.body], 0, 0, this.label);
  }

  typecheck({ e, e_all, sub, r, ctx }: TypecheckState): TypeEnvironment {
    if (this.condition) this.condition.check(create_type("bool"), { e, sub, ctx, e_all });
    // the loop runs in a forked environment, so its variables do not leak out
    this.body.typecheck({ e: new Map(e), e_all: new Map(e_all), sub, r, ctx });
    return e;
  }
}

export class DoWhileStatementNode extends StatementNode {
  constructor(
    public readonly label: string | null,
    public readonly body: StatementNode,
    public readonly condition: ExpressionNode,
  ) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    return run_loop(thread, frame, interpreter, [this.body, new LoopConditionNode(this.condition)], 0, 1, this.label);
  }

  typecheck({ e, e_all, sub, r, ctx }: TypecheckState): TypeEnvironment {
    if (this.condition) this.condition.check(create_type("bool"), { e, sub, ctx, e_all });
    // the loop runs in a forked environment, so its variables do not leak out
    this.body.typecheck({ e: new Map(e), e_all: new Map(e_all), sub, r, ctx });
    return e;
  }
}

export class ForStatementNode extends StatementNode {
  constructor(
    public readonly label: string | null,
    public readonly init: VariableDeclarationNode | null,
    public readonly condition: ExpressionNode | null,
    public readonly update: ExpressionNode | null,
    public readonly body: StatementNode,
  ) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    // statement list: [init?] condition body [update?]; the iteration rewinds at the condition
    const statements: StatementNode[] = [];
    if (this.init !== null) statements.push(this.init);
    const condition_index = statements.length;
    statements.push(new LoopConditionNode(this.condition));
    statements.push(this.body);
    let continue_index = condition_index;
    if (this.update !== null) {
      statements.push(new ExpressionStatementNode(this.update));
      continue_index = statements.length - 1;
    }
    return run_loop(thread, frame, interpreter, statements, condition_index, continue_index, this.label);
  }

  typecheck({ e, e_all, sub, r, ctx }: TypecheckState): TypeEnvironment {
    // the loop runs in a forked environment, so its variables do not leak out
    const loop_env_all = new Map(e_all);
    let loop_env = new Map(e);
    if (this.init) loop_env = this.init.typecheck({ e: loop_env, e_all: loop_env_all, sub, r, ctx });
    if (this.condition) this.condition.check(create_type("bool"), { e: loop_env, e_all: loop_env_all, sub, ctx });
    this.body.typecheck({ e: loop_env, e_all: loop_env_all, sub, r, ctx });
    if (this.update) this.update.infer({ e: loop_env, e_all: loop_env_all, sub, ctx });
    return e;
  }
}

/** True when `st` contains a return statement anywhere in its nested statements. */
export function statement_has_return(st: StatementNode): boolean {
  if (st instanceof ReturnStatementNode) return true;
  if (st instanceof BlockStatementNode) return body_has_return(st);
  if (st instanceof IfStatementNode)
    return statement_has_return(st.then_body) || (st.else_body !== null && statement_has_return(st.else_body));
  if (st instanceof WhileStatementNode || st instanceof DoWhileStatementNode) return statement_has_return(st.body);
  if (st instanceof ForStatementNode) return statement_has_return(st.body);

  return false;
}

export function body_has_return(body: BlockStatementNode): boolean {
  return body.statements.get_items().some((st) => statement_has_return(st));
}

export class BreakStatementNode extends StatementNode {
  constructor(public readonly label: string | null) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    void frame;
    const target = find_loop_frame(thread, this.label);
    if (target === null)
      throw new Error(this.label === null ? "Break outside of a loop" : `No loop with label "${this.label}"`);
    interpreter.finish_frame(thread, target, new NullValue());
    return { kind: "suspended" };
  }

  typecheck(state: TypecheckState): TypeEnvironment {
    return state.e;
  }
}

export class ContinueStatementNode extends StatementNode {
  constructor(public readonly label: string | null) {
    super();
  }

  execute(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    void frame;
    const target = find_loop_frame(thread, this.label);
    if (target === null)
      throw new Error(this.label === null ? "Continue outside of a loop" : `No loop with label "${this.label}"`);
    target.counter = target.continue_index;
    thread.call_frame = target;
    return { kind: "suspended" };
  }

  typecheck(state: TypecheckState): TypeEnvironment {
    return state.e;
  }
}
