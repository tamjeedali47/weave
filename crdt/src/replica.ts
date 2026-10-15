import { FugueDoc } from "./fugue.js";
import { idKey, type DeleteOp, type Id, type InsertOp, type Op, type ReplicaId } from "./types.js";

export type VersionVector = Readonly<Record<ReplicaId, number>>;

/**
 * - "applied": integrated now (possibly releasing buffered ops too).
 * - "buffered": held until the ops it depends on arrive.
 * - "duplicate": already applied or already buffered; ignored.
 */
export type ReceiveResult = "applied" | "buffered" | "duplicate";

/**
 * A FugueDoc plus what it needs to live on an unreliable network:
 *
 * - A buffer, so ops can arrive in any order and any number of times.
 * - A log of every applied op, so it can send a peer exactly the ops that
 *   peer is missing (version-vector sync), e.g. after being offline.
 */
export class Replica {
  private readonly doc: FugueDoc;
  /** Every applied op, in the order this replica applied it. */
  private readonly log: Op[] = [];
  /** Buffered ops by idKey, for duplicate detection. */
  private readonly pending = new Map<string, Op>();
  /** Buffered ops, grouped by the idKey of the op they are waiting for. */
  private readonly waiting = new Map<string, Op[]>();

  constructor(id: ReplicaId) {
    this.doc = new FugueDoc(id);
  }

  get id(): ReplicaId {
    return this.doc.replica;
  }

  get length(): number {
    return this.doc.length;
  }

  /** Number of ops received but not yet applied. */
  get pendingCount(): number {
    return this.pending.size;
  }

  toString(): string {
    return this.doc.toString();
  }

  versionVector(): VersionVector {
    return this.doc.versionVector();
  }

  insert(index: number, text: string): InsertOp[] {
    return this.record(this.doc.insert(index, text));
  }

  delete(index: number, count = 1): DeleteOp[] {
    return this.record(this.doc.delete(index, count));
  }

  receive(op: Op): ReceiveResult {
    if (!Number.isInteger(op.id.counter) || op.id.counter < 1) {
      throw new Error(`Op ${idKey(op.id)} has an invalid counter`);
    }
    if (this.doc.has(op.id) || this.pending.has(idKey(op.id))) return "duplicate";
    const missing = this.missingDependency(op);
    if (missing !== null) {
      this.pending.set(idKey(op.id), op);
      this.park(op, missing);
      return "buffered";
    }
    this.applyAndRelease(op);
    return "applied";
  }

  /**
   * Ops this replica has applied that a peer with version vector `vv` lacks,
   * in this replica's application order (so a peer can usually apply them
   * without buffering).
   */
  opsSince(vv: VersionVector): Op[] {
    return this.log.filter((op) => {
      const seen = Object.hasOwn(vv, op.id.replica) ? vv[op.id.replica]! : 0;
      return op.id.counter > seen;
    });
  }

  /**
   * The first op `op` still depends on, or null if it can be applied now.
   * An op needs its replica's previous op (so version vectors stay exact) and
   * its parent (insert) or target (delete).
   */
  private missingDependency(op: Op): Id | null {
    if (op.id.counter > 1) {
      const previous: Id = { replica: op.id.replica, counter: op.id.counter - 1 };
      if (!this.doc.has(previous)) return previous;
    }
    const dependency = op.type === "insert" ? op.parent : op.target;
    if (dependency !== null && !this.doc.has(dependency)) return dependency;
    return null;
  }

  private park(op: Op, missing: Id): void {
    const key = idKey(missing);
    const queue = this.waiting.get(key);
    if (queue === undefined) this.waiting.set(key, [op]);
    else queue.push(op);
  }

  /**
   * Applies `op`, then any buffered ops that were waiting on it, transitively.
   * Each buffered op waits on exactly one missing ID at a time, so it is only
   * re-examined when that ID arrives: total work is linear in the number of
   * ops rather than rescanning the buffer after every arrival.
   */
  private applyAndRelease(op: Op): void {
    const ready: Op[] = [op];
    while (ready.length > 0) {
      const next = ready.pop()!;
      this.doc.apply(next);
      this.log.push(next);
      const key = idKey(next.id);
      const woken = this.waiting.get(key);
      if (woken === undefined) continue;
      this.waiting.delete(key);
      for (const candidate of woken) {
        const missing = this.missingDependency(candidate);
        if (missing === null) {
          this.pending.delete(idKey(candidate.id));
          ready.push(candidate);
        } else {
          this.park(candidate, missing);
        }
      }
    }
  }

  private record<T extends Op>(ops: T[]): T[] {
    // A loop rather than push(...ops): spreading a huge array overflows the stack.
    for (const op of ops) this.log.push(op);
    return ops;
  }
}
