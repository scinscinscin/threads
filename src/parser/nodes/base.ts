import { StatementNode } from "./statements";

export abstract class BaseNode {}

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
}

export class ProgramNode extends BaseNode {
  constructor(public readonly statements: ListNode<StatementNode>) {
    super();
  }
}
