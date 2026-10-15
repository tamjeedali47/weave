import {
  compareIds,
  idKey,
  type DeleteOp,
  type Id,
  type InsertOp,
  type Op,
  type ReplicaId,
} from "./types.js";

interface Node {
  /** null only for the root. */
  readonly id: Id | null;
  readonly char: string;
  deleted: boolean;
  /** Both sibling lists are kept sorted by compareIds. */
  readonly leftChildren: Node[];
  readonly rightChildren: Node[];
}

/**
 * A replica of a text document, stored as a Fugue tree.
 *
 * The text is an in-order walk of the tree: left children (sorted by ID), then
 * the node itself, then right children (sorted by ID), skipping tombstones.
 *
 * This is the straightforward reference version: finding a position walks the
 * whole tree, so local edits are O(n). It exists to be obviously correct, and
 * to serve as the oracle for faster versions later.
 *
 * `apply` only accepts operations that are causally ready (see its docs);
 * buffering out-of-order operations is layered on top separately.
 */
export class FugueDoc {
  readonly replica: ReplicaId;

  private readonly root: Node = {
    id: null,
    char: "",
    deleted: true,
    leftChildren: [],
    rightChildren: [],
  };
  private readonly nodes = new Map<string, Node>();
  /** Highest counter applied from each replica. */
  private readonly vv = new Map<ReplicaId, number>();
  private visibleLength = 0;

  constructor(replica: ReplicaId) {
    if (replica === "") throw new Error("Replica ID must be non-empty");
    this.replica = replica;
  }

  get length(): number {
    return this.visibleLength;
  }

  toString(): string {
    const chars: string[] = [];
    for (const node of this.traverse()) {
      if (!node.deleted) chars.push(node.char);
    }
    return chars.join("");
  }

  versionVector(): Readonly<Record<ReplicaId, number>> {
    return Object.fromEntries(this.vv);
  }

  /** Whether the operation with this ID has been applied. */
  has(id: Id): boolean {
    // Counters are gapless and applied in order, so the version vector is exact.
    return (this.vv.get(id.replica) ?? 0) >= id.counter;
  }

  /** Inserts `text` so that its first character ends up at `index`. */
  insert(index: number, text: string): InsertOp[] {
    this.checkRange(index, 0);
    const ops: InsertOp[] = [];
    let left = index === 0 ? this.root : this.visibleNodes(index - 1, 1)[0]!;
    for (let k = 0; k < text.length; k++) {
      const op = this.makeInsert(left, text.charAt(k));
      left = this.applyReady(op)!;
      ops.push(op);
    }
    return ops;
  }

  /** Deletes `count` visible characters starting at `index`. */
  delete(index: number, count = 1): DeleteOp[] {
    this.checkRange(index, count);
    return this.visibleNodes(index, count).map((node) => {
      const op: DeleteOp = { type: "delete", id: this.nextId(), target: node.id! };
      this.applyReady(op);
      return op;
    });
  }

  /**
   * Applies an operation received from another replica.
   *
   * Returns false if the operation was already applied (duplicate delivery).
   * Throws if it is not causally ready: it must be the next operation from its
   * replica, and its parent (insert) or target (delete) must already exist.
   */
  apply(op: Op): boolean {
    const seen = this.vv.get(op.id.replica) ?? 0;
    if (op.id.counter <= seen) return false;
    if (op.id.counter !== seen + 1) {
      throw new Error(
        `Op ${idKey(op.id)} not ready: expected counter ${seen + 1} from ${op.id.replica}`,
      );
    }
    this.applyReady(op);
    return true;
  }

  /**
   * The Fugue insert rule. `left` is the element immediately left of the
   * cursor (the root when inserting at the start).
   *
   * - If `left` has no right children, the new element becomes its right
   *   child. This is the common case when typing forwards.
   * - Otherwise something already sits immediately after `left` in the walk:
   *   the leftmost node of left's right subtree. That node has no left
   *   children by construction, so the new element becomes its left child,
   *   placing it between `left` and that node.
   *
   * Either way the new element lands exactly between `left` and its successor.
   * Concurrent inserts at the same spot become siblings, ordered by ID, and
   * each user's run of characters stays together in its own subtree instead of
   * interleaving with the other user's run.
   */
  private makeInsert(left: Node, char: string): InsertOp {
    const id = this.nextId();
    const firstRight = left.rightChildren[0];
    if (firstRight === undefined) {
      return { type: "insert", id, parent: left.id, side: "R", char };
    }
    let successor = firstRight;
    while (successor.leftChildren[0] !== undefined) successor = successor.leftChildren[0];
    return { type: "insert", id, parent: successor.id, side: "L", char };
  }

  /** Integrates a causally ready op. Returns the new node for inserts. */
  private applyReady(op: Op): Node | undefined {
    let created: Node | undefined;
    if (op.type === "insert") {
      created = this.integrateInsert(op);
    } else {
      this.integrateDelete(op);
    }
    this.vv.set(op.id.replica, op.id.counter);
    return created;
  }

  private integrateInsert(op: InsertOp): Node {
    if (op.char.length !== 1) {
      throw new Error(`Op ${idKey(op.id)} must insert exactly one UTF-16 code unit`);
    }
    const parent = op.parent === null ? this.root : this.nodes.get(idKey(op.parent));
    if (parent === undefined) {
      throw new Error(`Op ${idKey(op.id)} not ready: parent ${idKey(op.parent!)} missing`);
    }
    const node: Node = {
      id: op.id,
      char: op.char,
      deleted: false,
      leftChildren: [],
      rightChildren: [],
    };
    insertSorted(op.side === "L" ? parent.leftChildren : parent.rightChildren, node);
    this.nodes.set(idKey(op.id), node);
    this.visibleLength++;
    return node;
  }

  private integrateDelete(op: DeleteOp): void {
    const target = this.nodes.get(idKey(op.target));
    if (target === undefined) {
      throw new Error(`Op ${idKey(op.id)} not ready: target ${idKey(op.target)} missing`);
    }
    // Concurrent deletes of the same element are fine: the second is a no-op.
    if (!target.deleted) {
      target.deleted = true;
      this.visibleLength--;
    }
  }

  private nextId(): Id {
    return { replica: this.replica, counter: (this.vv.get(this.replica) ?? 0) + 1 };
  }

  private checkRange(index: number, count: number): void {
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      index < 0 ||
      count < 0 ||
      index + count > this.visibleLength
    ) {
      throw new RangeError(
        `Range [${index}, ${index + count}) out of bounds for length ${this.visibleLength}`,
      );
    }
  }

  /** Returns `count` visible nodes starting at visible position `index`. */
  private visibleNodes(index: number, count: number): Node[] {
    const result: Node[] = [];
    if (count === 0) return result;
    let position = 0;
    for (const node of this.traverse()) {
      if (node.deleted) continue;
      if (position >= index) {
        result.push(node);
        if (result.length === count) break;
      }
      position++;
    }
    return result;
  }

  /**
   * In-order walk of all nodes, tombstones included, root excluded.
   *
   * Iterative on purpose: typing forwards builds a chain of right children as
   * deep as the document is long, which would overflow the call stack if walked
   * recursively.
   */
  private *traverse(): Generator<Node> {
    const stack: Array<{ node: Node; visit: boolean }> = [{ node: this.root, visit: false }];
    while (stack.length > 0) {
      const { node, visit } = stack.pop()!;
      if (visit) {
        yield node;
        continue;
      }
      // Pushed in reverse so they pop as: left children, node, right children.
      for (let i = node.rightChildren.length - 1; i >= 0; i--) {
        stack.push({ node: node.rightChildren[i]!, visit: false });
      }
      if (node !== this.root) stack.push({ node, visit: true });
      for (let i = node.leftChildren.length - 1; i >= 0; i--) {
        stack.push({ node: node.leftChildren[i]!, visit: false });
      }
    }
  }
}

function insertSorted(siblings: Node[], node: Node): void {
  let i = siblings.length;
  while (i > 0 && compareIds(siblings[i - 1]!.id!, node.id!) > 0) i--;
  siblings.splice(i, 0, node);
}
