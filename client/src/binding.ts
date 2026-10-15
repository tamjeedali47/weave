import { ChangeSet, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Op, Replica, TextChange } from "@weave/crdt";

/**
 * Keeps one CodeMirror editor and one Replica in lockstep.
 *
 * - Local edits: each editor transaction is translated into CRDT ops, applied
 *   to the replica, and handed to `onLocalOps` for sending.
 * - Remote ops: `receive` feeds them to the replica, collects the text changes
 *   it reports, and applies them to the editor as one transaction.
 *
 * Remote transactions are tagged with Transaction.remote so the update
 * listener does not turn them back into ops (which would echo forever), and
 * are kept out of undo history so Ctrl+Z only undoes your own typing.
 */
export class EditorBinding {
  readonly view: EditorView;
  private readonly replica: Replica;
  private readonly onLocalOps: (ops: Op[]) => void;
  /** Text changes reported during the current `receive` call. */
  private incoming: TextChange[] | null = null;

  constructor(options: {
    replica: Replica;
    parent: HTMLElement;
    extensions?: Extension;
    onLocalOps: (ops: Op[]) => void;
  }) {
    this.replica = options.replica;
    this.onLocalOps = options.onLocalOps;
    this.view = new EditorView({
      parent: options.parent,
      doc: this.replica.toString(),
      extensions: [
        options.extensions ?? [],
        EditorView.updateListener.of((update) => this.handleUpdate(update)),
      ],
    });
    this.replica.onRemoteChange = (change) => {
      if (this.incoming === null) throw new Error("Remote change outside receive()");
      this.incoming.push(change);
    };
  }

  /** Applies ops from other replicas, in any order, duplicates allowed. */
  receive(ops: readonly Op[]): void {
    this.incoming = [];
    let changes: TextChange[];
    try {
      for (const op of ops) this.replica.receive(op);
    } finally {
      changes = this.incoming;
      this.incoming = null;
    }
    if (changes.length === 0) return;
    this.view.dispatch({
      changes: coalesce(changes).map(toChangeSpec),
      // Each change's position is relative to the text after the previous one,
      // because that is the order the replica applied them in.
      sequential: true,
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    });
  }

  destroy(): void {
    this.replica.onRemoteChange = null;
    this.view.destroy();
  }

  private handleUpdate(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      if (!tr.docChanged || tr.annotation(Transaction.remote)) continue;
      const ops = this.toOps(tr.changes);
      if (ops.length > 0) this.onLocalOps(ops);
    }
  }

  /**
   * Converts one editor transaction into CRDT ops, applying them locally.
   *
   * CodeMirror reports change positions relative to the document *before*
   * the transaction. Applying them from last to first means each change sees
   * exactly the positions it was described with: edits further right never
   * shift text to their left.
   */
  private toOps(changes: ChangeSet): Op[] {
    const edits: Array<{ from: number; to: number; text: string }> = [];
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      edits.push({ from: fromA, to: toA, text: inserted.toString() });
    });
    let ops: Op[] = [];
    for (const { from, to, text } of edits.reverse()) {
      // concat, not push(...): spreading a huge paste would overflow the stack.
      if (to > from) ops = ops.concat(this.replica.delete(from, to - from));
      if (text.length > 0) ops = ops.concat(this.replica.insert(from, text));
    }
    return ops;
  }
}

/**
 * Merges runs of single-character changes (the CRDT reports one per op) into
 * larger ones, so a remote paste becomes one editor change, not thousands.
 */
function coalesce(changes: readonly TextChange[]): TextChange[] {
  const merged: TextChange[] = [];
  for (const change of changes) {
    const last = merged.at(-1);
    if (last?.type === "insert" && change.type === "insert" && change.index === last.index + last.text.length) {
      merged[merged.length - 1] = { type: "insert", index: last.index, text: last.text + change.text };
    } else if (last?.type === "delete" && change.type === "delete" && change.index === last.index) {
      merged[merged.length - 1] = { type: "delete", index: last.index, count: last.count + change.count };
    } else {
      merged.push(change);
    }
  }
  return merged;
}

function toChangeSpec(change: TextChange): ChangeSpec {
  return change.type === "insert"
    ? { from: change.index, insert: change.text }
    : { from: change.index, to: change.index + change.count };
}
