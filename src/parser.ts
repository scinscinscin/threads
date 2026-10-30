import { buildProductions, Sparse } from "@scinorandex/sparse";
import fs from "fs";
import path from "path";
import { generate_lexer, Metadata, Token, TokenType } from "./lexer";

import { BaseNode, ListNode, ProgramNode } from "./parser/nodes/base";
import {
  BlockStatementNode,
  BreakStatementNode,
  ContinueStatementNode,
  DoWhileStatementNode,
  ExpressionStatementNode,
  ForStatementNode,
  IfStatementNode,
  ReturnStatementNode,
  StatementNode,
  VariableDeclarationNode,
  WhileStatementNode,
} from "./parser/nodes/statements";
import {
  ArrayAccessExpressionNode,
  ArrayLiteralExpressionNode,
  AssignmentExpressionNode,
  BinaryExpressionNode,
  DotAccessExpressionNode,
  ExpressionNode,
  FunctionCallExpressionNode,
  FunctionExpressionNode,
  GroupingExpressionNode,
  IdentifierExpressionNode,
  LiteralExpressionNode,
  ObjectLiteralExpressionNode,
  ObjectPropertyNode,
  UnaryExpressionNode,
} from "./parser/nodes/expressions";

type Reducer = (bag: any) => BaseNode;

/** Statement productions from the new grammar that have no node implementations yet. */
const not_implemented =
  (name: string): Reducer =>
  () => {
    throw new Error(`${name}: not implemented yet`);
  };

const binary_level = (bag: { left: ExpressionNode; op?: Token; right?: ExpressionNode }): BaseNode =>
  bag.op === undefined ? bag.left : new BinaryExpressionNode(bag.left, bag.op, bag.right!);

const reducers = {
  program: (bag: { stmts?: ListNode<StatementNode> }) => new ProgramNode(bag.stmts ?? new ListNode<StatementNode>([])),

  top_level_stmts: (bag: { stmt: StatementNode; rest?: ListNode<StatementNode> }) =>
    new ListNode<StatementNode>([bag.stmt, ...(bag.rest?.get_items() ?? [])]),
  top_level_stmt: (bag: { stmt: StatementNode }) => bag.stmt,
  top_level_decl: (bag: { decl: StatementNode }) => bag.decl,
  stmts: (bag: { stmt: StatementNode; rest?: ListNode<StatementNode> }) =>
    new ListNode<StatementNode>([bag.stmt, ...(bag.rest?.get_items() ?? [])]),
  stmt: (bag: { stmt: StatementNode }) => bag.stmt,
  decl: (bag: { decl: StatementNode }) => bag.decl,

  block_statement: (bag: { stmts?: ListNode<StatementNode> }) =>
    new BlockStatementNode(bag.stmts ?? new ListNode<StatementNode>([])),
  params_list: (bag: { param: Token; rest?: ListNode<Token> }) =>
    new ListNode<Token>([bag.param, ...(bag.rest?.get_items() ?? [])]),
  param: (bag: { parameter_name: Token }) => bag.parameter_name,
  var_decl: (bag: { variable_name: Token; value: ExpressionNode }) =>
    new VariableDeclarationNode(bag.variable_name, bag.value),
  // for-loop initializer: same shape as var_decl but without the trailing semicolon
  for_var_decl: (bag: { variable_name: Token; value: ExpressionNode }) =>
    new VariableDeclarationNode(bag.variable_name, bag.value),
  return_stmt: (bag: { expr?: ExpressionNode }) => new ReturnStatementNode(bag.expr ?? null),
  expr_stmt: (bag: { expr: ExpressionNode }) => new ExpressionStatementNode(bag.expr),

  class_decl: not_implemented("class_decl"),
  class_properties: not_implemented("class_properties"),
  class_property: not_implemented("class_property"),
  if_statement: (bag: { condition: ExpressionNode; then_body: StatementNode; else_body?: StatementNode }) =>
    new IfStatementNode(bag.condition, bag.then_body, bag.else_body ?? null),
  for_statement: (bag: {
    label?: Token;
    var_decl?: VariableDeclarationNode;
    condition?: ExpressionNode;
    update?: ExpressionNode;
    body: StatementNode;
  }) =>
    new ForStatementNode(
      bag.label?.lexeme ?? null,
      bag.var_decl ?? null,
      bag.condition ?? null,
      bag.update ?? null,
      bag.body,
    ),
  while_statement: (bag: { label?: Token; condition: ExpressionNode; body: StatementNode }) =>
    new WhileStatementNode(bag.label?.lexeme ?? null, bag.condition, bag.body),
  do_while_statement: (bag: { label?: Token; body: StatementNode; condition: ExpressionNode }) =>
    new DoWhileStatementNode(bag.label?.lexeme ?? null, bag.body, bag.condition),
  break_statement: (bag: { label?: Token }) => new BreakStatementNode(bag.label?.lexeme ?? null),
  continue_statement: (bag: { label?: Token }) => new ContinueStatementNode(bag.label?.lexeme ?? null),

  expression: (bag: { expr: ExpressionNode }) => bag.expr,
  or_expr: binary_level,
  and_expr: binary_level,
  equality_expr: binary_level,
  relation_expr: binary_level,
  additive_expr: binary_level,
  multiplicative_expr: binary_level,
  unary_expr: (bag: { op: Token; operand: ExpressionNode }) => new UnaryExpressionNode(bag.op, bag.operand),
  endpoint_expr: (bag: { expr: ExpressionNode }) => bag.expr,
  literal_expr: (bag: { expr: ExpressionNode }) => bag.expr,

  object_literal_expr: (bag: { object_properties: ListNode<ObjectPropertyNode> }) =>
    new ObjectLiteralExpressionNode(bag.object_properties),
  object_properties: (bag: { object_property: ObjectPropertyNode; rest?: ListNode<ObjectPropertyNode> }) =>
    new ListNode<ObjectPropertyNode>([bag.object_property, ...(bag.rest?.get_items() ?? [])]),
  object_property: (bag: { key: Token; value: ExpressionNode }) => new ObjectPropertyNode(bag.key, bag.value),

  array_literal_expr: (bag: { array_properties?: ListNode<ExpressionNode> }) =>
    new ArrayLiteralExpressionNode(bag.array_properties ?? new ListNode<ExpressionNode>([])),
  array_properties: (bag: { expr: ExpressionNode; rest?: ListNode<ExpressionNode> }) =>
    new ListNode<ExpressionNode>([bag.expr, ...(bag.rest?.get_items() ?? [])]),
  primitive_literal_expr: (bag: { value: Token }) => new LiteralExpressionNode(bag.value),

  function_expr: (bag: { async_mod?: Token; params_list?: ListNode<Token>; body: BlockStatementNode }) =>
    new FunctionExpressionNode(bag.async_mod !== undefined, bag.params_list ?? new ListNode<Token>([]), bag.body),

  assignment_expr: (bag: { identifier_expr: ExpressionNode; expr?: ExpressionNode }) =>
    bag.expr === undefined ? bag.identifier_expr : new AssignmentExpressionNode(bag.identifier_expr, bag.expr),
  identifier_expr: (bag: { identifier: Token }) => new IdentifierExpressionNode(bag.identifier),
  grouping_expr: (bag: { expr: ExpressionNode }) => new GroupingExpressionNode(bag.expr),
  array_access_expr: (bag: { expr: ExpressionNode; index: ExpressionNode }) =>
    new ArrayAccessExpressionNode(bag.expr, bag.index),
  dot_access_expr: (bag: { expr: ExpressionNode; key: Token }) => new DotAccessExpressionNode(bag.expr, bag.key),
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
    conflicts: "shift",
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
