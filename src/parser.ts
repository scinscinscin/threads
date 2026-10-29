import { buildProductions, Sparse } from "@scinorandex/sparse";
import fs from "fs";
import path from "path";
import { generate_lexer, Metadata, Token, TokenType } from "./lexer";
import {
  BooleanValue,
  BuiltInAsyncFunctionValue,
  BuiltInFunctionValue,
  FunctionValue,
  NumberValue,
  PromiseValue,
  StringValue,
  Value,
} from "./value";
import { CallFrame, Interpreter, Thread } from "./interpreter";

abstract class BaseNode {}

export class ListNode<T> extends BaseNode {
  constructor(private readonly items: T[]) {
    super();
  }

  add(node: T) {
    this.items.push(node);
    return this;
  }

  get_items() {
    return this.items;
  }

  get_items_reversed() {
    return this.items.toReversed();
  }
}

export class ProgramNode extends BaseNode {
  constructor(public readonly statements: ListNode<StatementNode>) {
    super();
  }
}

type StatementOutcome = { kind: "ok" } | { kind: "return"; value: Value } | { kind: "suspended" };
export abstract class StatementNode extends BaseNode {
  abstract eval(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome;
}

export class BlockStatementNode extends StatementNode {
  constructor(public readonly statements: ListNode<StatementNode>) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    const block_frame = new CallFrame(this.statements.get_items(), frame.environment.fork(), frame.is_async_context);
    block_frame.parent = frame;
    // `return` statements bypass the block frame
    block_frame.captures_return = false;
    thread.call_frame = block_frame;
    interpreter.step_frame(thread);
    return thread.suspended_or_ok();
  }
}

export class FunctionDeclarationNode extends StatementNode {
  constructor(
    public readonly is_async: boolean,
    public readonly identifier: Token,
    public readonly params_list: ListNode<Token>,
    public readonly body: BlockStatementNode,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame): StatementOutcome {
    const name = this.identifier.lexeme;
    const params = this.params_list.get_items().map((t) => t.lexeme);
    const fn = new FunctionValue(name, frame.environment, this.is_async, params, this.body);
    frame.environment.add_key(name, fn);

    // atomic operation, no need to check if suspended
    return { kind: "ok" };
  }
}

export class VariableDeclarationNode extends StatementNode {
  constructor(
    public readonly variable_name: Token,
    public readonly value: ExpressionNode,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    const name = this.variable_name.lexeme;
    this.value.eval(thread, frame, interpreter, (value) => frame.environment.add_key(name, value));
    return thread.suspended_or_ok();
  }
}

export class ReturnStatementNode extends StatementNode {
  constructor(public readonly expression: ExpressionNode) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    let ret_value: Value | null = null;
    this.expression.eval(thread, frame, interpreter, (value) => (ret_value = value));

    // if the thread didn't become blocked while evaluating expression, can return the value immediately
    if (thread.status === "not_blocked") return { kind: "return", value: ret_value! };
    return { kind: "suspended" };
  }
}

export class ExpressionStatementNode extends StatementNode {
  constructor(public readonly expr: ExpressionNode) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter): StatementOutcome {
    this.expr.eval(thread, frame, interpreter, () => {});
    return thread.suspended_or_ok();
  }
}

export abstract class ExpressionNode extends BaseNode {
  abstract eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void;
}

export class AwaitExpressionNode extends ExpressionNode {
  constructor(public readonly expr: ExpressionNode) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    this.expr.eval(thread, frame, interpreter, (promise_value) => {
      if (!(promise_value instanceof PromiseValue)) k(promise_value);
      // if the promise is already resolved then k can be called just fine
      else if (promise_value.is_resolved()) k(promise_value.resolved!);
      else {
        if (!frame.is_async_context) throw new Error(`Await used in a non-async context`);
        // Not resolved yet so mark the thread as blocked and add k to function to call when promise is resolved

        thread.status = promise_value.internally_resolved ? "blocked_on_internal_promise" : "blocked";
        thread.blocked_on = promise_value;
        thread.pending = () => k(promise_value.resolved!);
        promise_value.waiters.push(thread);
      }
    });
  }
}

export class BinaryExpressionNode extends ExpressionNode {
  constructor(
    public readonly left: ExpressionNode,
    public readonly op: Token,
    public readonly right: ExpressionNode,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    this.left.eval(thread, frame, interpreter, (left) => {
      this.right.eval(thread, frame, interpreter, (right) => {
        k(this.apply_binary(left, this.op.type, right));
      });
    });
  }

  apply_binary(left: Value, op: TokenType, right: Value): Value {
    if (op === TokenType.PLUS) {
      if (left instanceof NumberValue && right instanceof NumberValue) return new NumberValue(left.value + right.value);
      if (left instanceof StringValue && right instanceof StringValue) return new StringValue(left.value + right.value);
      throw new Error(`Unsupported operands for "+": ${left.to_string()} and ${right.to_string()}`);
    }

    throw new Error(`Unsupported operator token: ${TokenType[op]}`);
  }
}

export class LiteralExpressionNode extends ExpressionNode {
  constructor(public readonly value: Token) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    const token = this.value;
    if (token.type === TokenType.NUMBER_LITERAL) k(new NumberValue(Number(token.lexeme)));
    else if (token.type === TokenType.STRING_LITERAL) k(new StringValue(token.lexeme));
    else if (token.type === TokenType.BOOLEAN_LITERAL) k(new BooleanValue(token.lexeme === "true"));
    else throw new Error(`Unexpected literal token: ${TokenType[token.type]}`);
  }
}

export class IdentifierExpressionNode extends ExpressionNode {
  constructor(public readonly identifier: Token) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    k(frame.environment.get(this.identifier.lexeme));
  }
}

export class FunctionCallExpressionNode extends ExpressionNode {
  constructor(
    public readonly left: ExpressionNode,
    public readonly args_list: ListNode<ExpressionNode>,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    const inside_exprs = this.args_list.get_items();

    this.left.eval(thread, frame, interpreter, (callee) => {
      const args: Value[] = [];

      const eval_next_arg = (index: number): void => {
        if (index >= inside_exprs.length) {
          // reached the end of the argument list, call the function
          if (callee instanceof BuiltInFunctionValue) {
            k(callee.call(args, { thread, interpreter }));
          } else if (callee instanceof BuiltInAsyncFunctionValue) {
            callee.call(args, { thread, interpreter }, k);
          } else if (callee instanceof FunctionValue) {
            // Execute function call here, changing behaviour whether sync or async
            callee.call(thread, frame, args, interpreter, k);
          } else throw new Error(`Function value not callable: ${callee.to_string()}`);
        } else {
          inside_exprs[index].eval(thread, frame, interpreter, (arg) => {
            args.push(arg);
            eval_next_arg(index + 1);
          });
        }
      };

      eval_next_arg(0);
    });
  }
}

type Reducer = (bag: any) => BaseNode;
const reducers = {
  program: (bag: { stmts: ListNode<StatementNode> }) => new ProgramNode(bag.stmts),
  stmts: (bag: { stmt: StatementNode; rest?: ListNode<StatementNode> }) =>
    new ListNode<StatementNode>([bag.stmt, ...(bag.rest?.get_items() ?? [])]),

  stmt: (bag: { stmt: StatementNode }) => bag.stmt,
  block_statement: (bag: { stmts?: ListNode<StatementNode> }) =>
    new BlockStatementNode(bag.stmts ?? new ListNode<StatementNode>([])),
  fn_decl: (bag: { async_mod?: Token; name: Token; params_list?: ListNode<Token>; body: BlockStatementNode }) =>
    new FunctionDeclarationNode(
      bag.async_mod !== undefined,
      bag.name,
      bag.params_list ?? new ListNode<Token>([]),
      bag.body,
    ),

  params_list: (bag: { parameter_name: Token; rest?: ListNode<Token> }) =>
    new ListNode<Token>([bag.parameter_name, ...(bag.rest?.get_items() ?? [])]),
  var_decl: (bag: { variable_name: Token; value: ExpressionNode }) =>
    new VariableDeclarationNode(bag.variable_name, bag.value),
  return_stmt: (bag: { expr: ExpressionNode }) => new ReturnStatementNode(bag.expr),
  expr_stmt: (bag: { expr: ExpressionNode }) => new ExpressionStatementNode(bag.expr),

  expression: (bag: { expr: ExpressionNode }) => bag.expr,
  await_expr: (bag: { op?: Token; expr: ExpressionNode }) =>
    bag.op === undefined ? bag.expr : new AwaitExpressionNode(bag.expr),

  term_expr: (bag: { left: ExpressionNode; op?: Token; right?: ExpressionNode }) =>
    bag.op === undefined ? bag.left : new BinaryExpressionNode(bag.left, bag.op, bag.right!),
  endpoint_expr: (bag: { expr: ExpressionNode }) => bag.expr,
  literal_expr: (bag: { value: Token }) => new LiteralExpressionNode(bag.value),
  identifier_expr: (bag: { identifier: Token }) => new IdentifierExpressionNode(bag.identifier),
  function_call_expr: (bag: { expr: ExpressionNode; args_list?: ListNode<ExpressionNode> }) =>
    new FunctionCallExpressionNode(bag.expr, bag.args_list ?? new ListNode<ExpressionNode>([])),
  args_list: (bag: { expr: ExpressionNode; rest?: ListNode<ExpressionNode> }) =>
    new ListNode<ExpressionNode>([bag.expr, ...(bag.rest?.get_items() ?? [])]),
} as { [key: string]: Reducer };

const GRAMMAR_PATH = path.join(__dirname, "grammar.txt");
const GRAMMAR = fs.readFileSync(GRAMMAR_PATH, "utf8");

export function parse_program(source: string): ProgramNode {
  const parserGenerator = Sparse.fromProductions<TokenType, Metadata, BaseNode>({
    productions: buildProductions(GRAMMAR),
    toStringifiedTokenType: (type: TokenType) => TokenType[type],
  });

  const parser = parserGenerator.generate(generate_lexer(source), {
    reducer: ({ bag, name }, _) => {
      const reducer = reducers[name ?? ""];
      if (reducer === undefined) throw new Error(`No reducer for ${name}`);
      return reducer(bag);
    },
  });

  const { result, errors } = parser.parse();
  if (errors.length > 0) throw new Error(`Parse error: ${errors.map((e) => e.message).join("; ")}`);
  if (result === null) throw new Error("Parse failed: no result produced.");
  return result as ProgramNode;
}
