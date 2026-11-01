import { CallFrame, Interpreter, Thread } from "../../interpreter";
import {
  ArrayValue,
  BooleanValue,
  BuiltInAsyncFunctionValue,
  BuiltInFunctionValue,
  FunctionValue,
  is_truthy,
  NullValue,
  NumberValue,
  ObjectValue,
  PromiseValue,
  StringValue,
  Value,
} from "../../value";
import { Token, TokenType } from "../../lexer";
import { BaseNode, ListNode } from "./base";
import { body_has_return } from "./statements";
import type { BlockStatementNode } from "./statements";
import {
  check_unify,
  create_binding,
  create_type,
  get_fresh_counter_value,
  fresh_var,
  generalize,
  instantiate_binding,
  object_property_type,
  TypeCheckError,
  TypeEnvironment,
} from "../../typechecker";
import { resolve, Substitution, unify_write } from "../../typechecker/unify";
import { compound, show_type, Term } from "../../typechecker/ast";
import { check_intrinsic_call, intrinsics } from "../../typechecker/intrinsics";

export abstract class ExpressionNode extends BaseNode {
  abstract eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void;
  abstract infer(e: TypeEnvironment, sub: Substitution): Term;
  abstract check(type: Term, e: TypeEnvironment, sub: Substitution): void;
}

export class UnaryExpressionNode extends ExpressionNode {
  constructor(
    public readonly op: Token,
    public readonly operand: ExpressionNode,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    if (this.op.type === TokenType.MINUS) {
      this.operand.eval(thread, frame, interpreter, (value) => {
        if (!(value instanceof NumberValue)) throw new Error(`Unary "-" requires a number, got ${value.to_string()}`);
        k(new NumberValue(-value.value));
      });
    } else if (this.op.type === TokenType.NOT) {
      this.operand.eval(thread, frame, interpreter, (value) => k(new BooleanValue(!is_truthy(value))));
    } else if (this.op.type === TokenType.AWAIT) {
      this.operand.eval(thread, frame, interpreter, (promise_value) => {
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
    } else throw new Error(`Unsupported unary operator token: ${TokenType[this.op.type]}`);
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    if (this.op.type === TokenType.MINUS) {
      const operand = this.operand.infer(e, sub);
      check_unify(operand, create_type("int"), sub, `Unary "-" requires an int operand`);
      return create_type("int");
    }

    if (this.op.type === TokenType.NOT) {
      this.operand.infer(e, sub);
      return create_type("bool");
    }

    if (this.op.type === TokenType.AWAIT) {
      const operand = this.operand.infer(e, sub);
      // a promise unwraps to its inner type; anything else passes through
      // with its own type, mirroring the runtime
      const m = sub.mark();

      const inner = fresh_var();
      if (unify_write(operand, create_type("promise", [inner]), sub)) return resolve(inner, sub.map);
      sub.unmark(m);

      return operand;
    }

    throw new TypeCheckError(`Unsupported unary operator token: ${TokenType[this.op.type]}`, this.op);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub);
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
    // Logical operators short-circuit: the right side is only evaluated when needed,
    // which matters when it contains calls or awaits with side effects
    if (this.op.type === TokenType.AND || this.op.type === TokenType.OR) {
      const is_and = this.op.type === TokenType.AND;
      this.left.eval(thread, frame, interpreter, (left) => {
        if (is_and ? !is_truthy(left) : is_truthy(left)) k(left);
        else this.right.eval(thread, frame, interpreter, k);
      });

      return;
    }

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

    const as_numbers = (fn: (l: number, r: number) => Value) => {
      if (!(left instanceof NumberValue && right instanceof NumberValue))
        throw new Error(`Unsupported operands for "${TokenType[op]}": ${left.to_string()} and ${right.to_string()}`);
      return fn(left.value, right.value);
    };

    switch (op) {
      case TokenType.MINUS:
        return as_numbers((l, r) => new NumberValue(l - r));
      case TokenType.MULTIPLY:
        return as_numbers((l, r) => new NumberValue(l * r));
      case TokenType.DIVIDE:
        return as_numbers((l, r) => {
          if (r === 0) throw new Error(`Division by zero`);
          return new NumberValue(l / r);
        });

      case TokenType.EQUAL_EQUAL:
        return new BooleanValue(left.equals(right));
      case TokenType.NOT_EQUAL:
        return new BooleanValue(!left.equals(right));

      case TokenType.LESS_THAN:
        return as_numbers((l, r) => new BooleanValue(l < r));
      case TokenType.GREATER_THAN:
        return as_numbers((l, r) => new BooleanValue(l > r));
      case TokenType.LESS_EQUAL:
        return as_numbers((l, r) => new BooleanValue(l <= r));
      case TokenType.GREATER_EQUAL:
        return as_numbers((l, r) => new BooleanValue(l >= r));

      default:
        throw new Error(`Unsupported operator token: ${TokenType[op]}`);
    }
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const op = this.op.type;

    if (op === TokenType.AND || op === TokenType.OR) {
      // the short-circuit operators return one of their operands, so both
      // sides must share a type

      const left = this.left.infer(e, sub);
      const right = this.right.infer(e, sub);

      check_unify(right, left, sub, `"${this.op.lexeme}" operands must have the same type`);
      return resolve(left, sub.map);
    }

    if (op === TokenType.PLUS) {
      const left = this.left.infer(e, sub);
      const right = this.right.infer(e, sub);

      // overloaded: int + int or str + str, decided by backtracking
      const m = sub.mark();
      if (unify_write(left, create_type("int"), sub) && unify_write(right, create_type("int"), sub))
        return create_type("int");
      sub.unmark(m);

      const m2 = sub.mark();
      if (unify_write(left, create_type("str"), sub) && unify_write(right, create_type("str"), sub))
        return create_type("str");

      sub.unmark(m2);
      throw new TypeCheckError(`Unsupported operands for "+"`, this.op);
    }

    const left = this.left.infer(e, sub);
    const right = this.right.infer(e, sub);

    if (op === TokenType.MINUS || op === TokenType.MULTIPLY || op === TokenType.DIVIDE) {
      check_unify(left, create_type("int"), sub, `Left operand of "${this.op.lexeme}"`);
      check_unify(right, create_type("int"), sub, `Right operand of "${this.op.lexeme}"`);
      return create_type("int");
    }

    if (op === TokenType.EQUAL_EQUAL || op === TokenType.NOT_EQUAL) {
      // the runtime compares any two values, so both sides stay unconstrained
      return create_type("bool");
    }

    if (
      op === TokenType.LESS_THAN ||
      op === TokenType.GREATER_THAN ||
      op === TokenType.LESS_EQUAL ||
      op === TokenType.GREATER_EQUAL
    ) {
      check_unify(left, create_type("int"), sub, `Left operand of "${this.op.lexeme}"`);
      check_unify(right, create_type("int"), sub, `Right operand of "${this.op.lexeme}"`);
      return create_type("bool");
    }

    throw new TypeCheckError(`Unsupported operator token: ${TokenType[op]}`, this.op);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    if (this.op.type === TokenType.AND || this.op.type === TokenType.OR) {
      // both sides must match the expected type directly
      this.left.check(type, e, sub);
      this.right.check(type, e, sub);
      return;
    }

    check_unify(this.infer(e, sub), type, sub);
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
    else if (token.type === TokenType.NULL_LITERAL) k(new NullValue());
    else throw new Error(`Unexpected literal token: ${TokenType[token.type]}`);
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const t = this.value.type;
    if (t === TokenType.NUMBER_LITERAL) return create_type("int");
    if (t === TokenType.STRING_LITERAL) return create_type("str");
    if (t === TokenType.BOOLEAN_LITERAL) return create_type("bool");
    if (t === TokenType.NULL_LITERAL) return create_type("null");
    throw new TypeCheckError(`Unexpected literal token: ${TokenType[t]}`, this.value);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub, `Literal "${this.value.lexeme}"`);
  }
}

export class IdentifierExpressionNode extends ExpressionNode {
  constructor(public readonly identifier: Token) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    k(frame.environment.get(this.identifier.lexeme));
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const name = this.identifier.lexeme;
    const binding = e.get(name);
    if (binding === undefined) throw new TypeCheckError(`Undefined variable "${name}"`, this.identifier);
    return instantiate_binding(binding, sub);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub, `Variable "${this.identifier.lexeme}"`);
  }
}

export class GroupingExpressionNode extends ExpressionNode {
  constructor(public readonly expr: ExpressionNode) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    this.expr.eval(thread, frame, interpreter, k);
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    return this.expr.infer(e, sub);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    this.expr.check(type, e, sub);
  }
}

/** Resolves a value used as an object key via `obj[index]` (number or string). */
function key_from_value(index_value: Value): string {
  if (index_value instanceof NumberValue) return index_value.value.toString();
  if (index_value instanceof StringValue) return index_value.value;
  throw new Error(`Invalid object key: ${index_value.to_string()}`);
}

export class ArrayAccessExpressionNode extends ExpressionNode {
  constructor(
    public readonly expr: ExpressionNode,
    public readonly index: ExpressionNode,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    this.expr.eval(thread, frame, interpreter, (obj) => {
      this.index.eval(thread, frame, interpreter, (index_value) => {
        if (obj instanceof ArrayValue) {
          if (!(index_value instanceof NumberValue))
            throw new Error(`Array index must be a number, got ${index_value.to_string()}`);
          k(obj.get(index_value.value));
          return;
        }

        if (obj instanceof ObjectValue) {
          k(obj.get(key_from_value(index_value)));
          return;
        }

        throw new Error(`Value is not indexable: ${obj.to_string()}`);
      });
    });
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const container = this.expr.infer(e, sub);
    const index = this.index.infer(e, sub);

    const elem = fresh_var();
    if (unify_write(container, create_type("array", [elem]), sub)) {
      check_unify(index, create_type("int"), sub, "Array index");
      return resolve(elem, sub.map);
    }

    // obj[key]: the accessed property is unknown, so the result stays unconstrained
    const resolved = resolve(container, sub.map);
    if (resolved.kind === "compound" && resolved.functor === "obj") return fresh_var();
    throw new TypeCheckError(`Value of type ${show_type(resolved)} is not indexable`);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub);
  }
}

export class DotAccessExpressionNode extends ExpressionNode {
  constructor(
    public readonly expr: ExpressionNode,
    public readonly key: Token,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    this.expr.eval(thread, frame, interpreter, (obj) => {
      if (!(obj instanceof ObjectValue)) throw new Error(`Value is not an object: ${obj.to_string()}`);
      k(obj.get(this.key.lexeme));
    });
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const resolved = resolve(this.expr.infer(e, sub), sub.map);
    if (resolved.kind === "var")
      throw new TypeCheckError(`Cannot access property "${this.key.lexeme}" on a value of unknown type`, this.key);

    const prop = object_property_type(resolved, this.key.lexeme);
    if (prop === null)
      throw new TypeCheckError(`No property "${this.key.lexeme}" on value of type ${show_type(resolved)}`, this.key);

    return resolve(prop, sub.map);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub);
  }
}

export class AssignmentExpressionNode extends ExpressionNode {
  constructor(
    public readonly target: ExpressionNode,
    public readonly value: ExpressionNode,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    // Resolve the assignment target first, then evaluate the value, then write

    if (this.target instanceof IdentifierExpressionNode) {
      const name = this.target.identifier.lexeme;
      return this.value.eval(thread, frame, interpreter, (value) => {
        frame.environment.set_key(name, value);
        k(value);
      });
    }

    if (this.target instanceof DotAccessExpressionNode) {
      const target = this.target;
      const key = target.key.lexeme;

      target.expr.eval(thread, frame, interpreter, (obj) => {
        if (!(obj instanceof ObjectValue)) throw new Error(`Invalid assignment target: ${obj.to_string()}`);

        this.value.eval(thread, frame, interpreter, (value) => {
          obj.set(key, value);
          k(value);
        });
      });

      return;
    }

    if (this.target instanceof ArrayAccessExpressionNode) {
      const target = this.target;
      target.expr.eval(thread, frame, interpreter, (container) => {
        target.index.eval(thread, frame, interpreter, (index_value) => {
          this.value.eval(thread, frame, interpreter, (value) => {
            if (container instanceof ArrayValue) {
              if (!(index_value instanceof NumberValue))
                throw new Error(`Array index must be a number, got ${index_value.to_string()}`);

              container.set(index_value.value, value);
            } else if (container instanceof ObjectValue) {
              container.set(key_from_value(index_value), value);
            } else throw new Error(`Value is not assignable: ${container.to_string()}`);
            k(value);
          });
        });
      });

      return;
    }

    throw new Error(`Invalid assignment target`);
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    if (this.target instanceof IdentifierExpressionNode) {
      const name = this.target.identifier.lexeme;
      const binding = e.get(name);
      if (binding === undefined) throw new TypeCheckError(`Undefined variable "${name}"`, this.target.identifier);
      if (binding.mutable === false)
        throw new TypeCheckError(`Cannot assign to immutable "${name}"`, this.target.identifier);

      // Check the new value against a fresh instance of the current type, then
      // refresh the binding's polytype from the new value. The Binding object is
      // mutated in place (rather than replacing the map entry) so the update is
      // visible from every scope that captured the variable, mirroring the
      // runtime's define-scope mutation.
      const declared = instantiate_binding(binding, sub);
      const before = get_fresh_counter_value();

      const value_expr_type = this.value.infer(e, sub);
      check_unify(value_expr_type, declared, sub, `Assignment to "${name}"`);
      binding.poly = generalize(value_expr_type, e, sub, before);
      return resolve(value_expr_type, sub.map);
    }

    if (this.target instanceof DotAccessExpressionNode) {
      const key = this.target.key.lexeme;
      const resolved = resolve(this.target.expr.infer(e, sub), sub.map);
      const property_type = object_property_type(resolved, key);

      if (property_type === null)
        throw new TypeCheckError(
          `No property "${key}" on value of type ${resolved.kind === "var" ? "unknown" : show_type(resolved)}`,
          this.target.key,
        );

      const value = this.value.infer(e, sub);
      check_unify(value, property_type, sub, `Assignment to "${key}"`);
      return resolve(property_type, sub.map);
    }

    if (this.target instanceof ArrayAccessExpressionNode) {
      const container = this.target.expr.infer(e, sub);
      const array_element_type = fresh_var();
      if (!unify_write(container, create_type("array", [array_element_type]), sub)) {
        const resolved = resolve(container, sub.map);
        throw new TypeCheckError(`Value of type ${show_type(resolved)} is not assignable`);
      }

      const index = this.target.index.infer(e, sub);
      check_unify(index, create_type("int"), sub, "Array index");

      const value = this.value.infer(e, sub);
      check_unify(value, array_element_type, sub, "Array assignment");
      return resolve(array_element_type, sub.map);
    }

    throw new TypeCheckError("Invalid assignment target");
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub);
  }
}

export class ObjectPropertyNode extends BaseNode {
  constructor(
    public readonly key: Token,
    public readonly value: ExpressionNode,
  ) {
    super();
  }
}

export class ObjectLiteralExpressionNode extends ExpressionNode {
  constructor(public readonly properties: ListNode<ObjectPropertyNode>) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    const properties = this.properties.get_items();
    const pairs: [string, Value][] = [];

    const eval_next = (index: number): void => {
      if (index >= properties.length) {
        return k(new ObjectValue(pairs));
      }
      properties[index].value.eval(thread, frame, interpreter, (value) => {
        pairs.push([properties[index].key.lexeme, value]);
        eval_next(index + 1);
      });
    };

    eval_next(0);
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const entries: [string, Term][] = [];
    const positions = new Map<string, number>();

    for (const prop of this.properties.get_items()) {
      const key = prop.key.lexeme;
      const type = prop.value.infer(e, sub);
      const existing = positions.get(key);

      // duplicate keys: last wins, mirroring the runtime's ObjectValue
      if (existing === undefined) {
        positions.set(key, entries.length);
        entries.push([key, type]);
      } else entries[existing] = [key, type];
    }

        // Property entries are named compounds, not registered types, so they are
    // built with raw `compound`; only the `obj` wrapper goes through create_type.
    return create_type("obj", entries.map(([key, type]) => compound(key, [type])));
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub, "Object literal");
  }
}

export class ArrayLiteralExpressionNode extends ExpressionNode {
  constructor(public readonly items: ListNode<ExpressionNode>) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    const items = this.items.get_items();
    const values: Value[] = [];

    const eval_next = (index: number): void => {
      if (index >= items.length) {
        return k(new ArrayValue(values));
      }

      items[index].eval(thread, frame, interpreter, (value) => {
        values.push(value);
        eval_next(index + 1);
      });
    };

    eval_next(0);
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const elem = fresh_var();
    for (const item of this.items.get_items()) check_unify(item.infer(e, sub), elem, sub, "Array element");
    return create_type("array", [resolve(elem, sub.map)]);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub, "Array literal");
  }
}

export class FunctionExpressionNode extends ExpressionNode {
  constructor(
    public readonly is_async: boolean,
    public readonly params_list: ListNode<Token>,
    public readonly body: BlockStatementNode,
  ) {
    super();
  }

  eval(thread: Thread, frame: CallFrame, interpreter: Interpreter, k: (value: Value) => void): void {
    const params = this.params_list.get_items().map((t) => t.lexeme);
    const fn = new FunctionValue("anon", frame.environment, this.is_async, params, this.body);
    k(fn);
  }

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const params = this.params_list.get_items();
    const parameter_types = params.map(() => fresh_var());
    const return_type = fresh_var();

    const body_env = new Map(e);
    params.forEach((token, i) => {
      body_env.set(token.lexeme, create_binding({ vars: [], type: parameter_types[i] }, true));
    });
    this.body.typecheck(body_env, sub, return_type);

    // a body without any return statement resolves to null at runtime. Only bind
    // in that case: a `return <param>` unifies return_type with the parameter
    // variable, which is also still unbound but is not a fall-off.
    if (body_has_return(this.body) === false) sub.bind(return_type.name, create_type("null"));

    // async-ness is encoded in the return type, so calls need no special case
    const ret_type = this.is_async ? create_type("promise", [return_type]) : return_type;
    return create_type("f", [...parameter_types, ret_type]);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub);
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
          if (callee instanceof BuiltInFunctionValue) k(callee.call(args, { thread, interpreter }));
          else if (callee instanceof BuiltInAsyncFunctionValue) callee.call(args, { thread, interpreter }, k);
          else if (callee instanceof FunctionValue) {
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

  infer(e: TypeEnvironment, sub: Substitution): Term {
    const arg_nodes = this.args_list.get_items();

    // named builtins use their full (possibly variadic) signature, unless
    // shadowed by a user declaration
    if (this.left instanceof IdentifierExpressionNode) {
      const name = this.left.identifier.lexeme;
      const sig = intrinsics.get(name);
      const binding = e.get(name);

      if (sig !== undefined && (binding === undefined || binding.builtin)) {
        const arg_types = arg_nodes.map((arg) => arg.infer(e, sub));
        check_intrinsic_call(name, sig, arg_types, sub, this.left.identifier);
        return resolve(sig.return, sub.map);
      }
    }

    const callee_type = this.left.infer(e, sub);
    const argument_types = arg_nodes.map((arg) => arg.infer(e, sub));
    const resolved_callee = resolve(callee_type, sub.map);
    const callee_token = this.left instanceof IdentifierExpressionNode ? this.left.identifier : undefined;

    if (resolved_callee.kind === "compound" && resolved_callee.functor === "f") {
      const arity = resolved_callee.args.length - 1;
      if (argument_types.length !== arity)
        throw new TypeCheckError(`Function expects ${arity} argument(s), got ${argument_types.length}`, callee_token);

      next_arg: for (let i = 0; i < arity; i++) {
        const param = resolve(resolved_callee.args[i], sub.map);
        if (param.kind === "atom" && param.name === "any") continue next_arg;
        check_unify(argument_types[i], param, sub, `Argument ${i + 1}`);
      }

      return resolve(resolved_callee.args[arity], sub.map);
    }

    if (resolved_callee.kind === "var") {
      // commit the callee to a function type matching this call's arity
      const ret = fresh_var();
      const param_types = argument_types.map(() => fresh_var());
      const fn_type = create_type("f", [...param_types, ret]);

      if (!unify_write(callee_type, fn_type, sub))
        throw new TypeCheckError(
          `Value of type ${show_type(resolve(callee_type, sub.map))} is not callable`,
          callee_token,
        );

      for (let i = 0; i < param_types.length; i++)
        check_unify(argument_types[i], param_types[i], sub, `Argument ${i + 1}`);

      return resolve(ret, sub.map);
    }

    throw new TypeCheckError(`Value of type ${show_type(resolved_callee)} is not callable`, callee_token);
  }

  check(type: Term, e: TypeEnvironment, sub: Substitution): void {
    check_unify(this.infer(e, sub), type, sub);
  }
}
