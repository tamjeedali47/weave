/** Identifies one editor session. Generated randomly and never reused. */
export type ReplicaId = string;

/**
 * Globally unique ID of an operation and, for inserts, of the element it creates.
 *
 * Each replica numbers its operations 1, 2, 3, ... with no gaps, so a version
 * vector (highest counter seen per replica) describes exactly which operations
 * a replica has applied.
 */
export interface Id {
  readonly replica: ReplicaId;
  readonly counter: number;
}

/** Which side of its parent an element hangs off in the Fugue tree. */
export type Side = "L" | "R";

export interface InsertOp {
  readonly type: "insert";
  readonly id: Id;
  /** Parent element, or null for the (invisible) root. */
  readonly parent: Id | null;
  readonly side: Side;
  /** A single UTF-16 code unit, matching CodeMirror's position model. */
  readonly char: string;
}

export interface DeleteOp {
  readonly type: "delete";
  readonly id: Id;
  /** The element being deleted. It stays in the tree as a tombstone. */
  readonly target: Id;
}

export type Op = InsertOp | DeleteOp;

/**
 * The visible effect of applying a remote op, as a position in the text
 * just before the change. This is what an editor needs to mirror the CRDT.
 */
export type TextChange =
  | { readonly type: "insert"; readonly index: number; readonly text: string }
  | { readonly type: "delete"; readonly index: number; readonly count: number };

/** Map key for an ID. Counters contain no comma, so the split is unambiguous. */
export function idKey(id: Id): string {
  return `${id.counter},${id.replica}`;
}

/** Total order on IDs, used to order siblings identically on every replica. */
export function compareIds(a: Id, b: Id): number {
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return a.counter - b.counter;
}
