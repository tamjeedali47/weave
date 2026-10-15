import { describe, expect, it } from "vitest";
import { Replica, type Op } from "../src/index.js";

/** Two-way version-vector sync, as on reconnect. */
function sync(a: Replica, b: Replica): void {
  const toB = a.opsSince(b.versionVector());
  const toA = b.opsSince(a.versionVector());
  for (const op of toB) b.receive(op);
  for (const op of toA) a.receive(op);
}

describe("out-of-order delivery", () => {
  it("buffers ops until their predecessors arrive", () => {
    const a = new Replica("a");
    const ops = a.insert(0, "abc");
    const b = new Replica("b");
    expect(b.receive(ops[2]!)).toBe("buffered");
    expect(b.receive(ops[1]!)).toBe("buffered");
    expect(b.toString()).toBe("");
    expect(b.pendingCount).toBe(2);
    expect(b.receive(ops[0]!)).toBe("applied");
    expect(b.toString()).toBe("abc");
    expect(b.pendingCount).toBe(0);
  });

  it("buffers ops until their parent arrives from another replica", () => {
    const a = new Replica("a");
    const fromA = a.insert(0, "x");
    const c = new Replica("c");
    c.receive(fromA[0]!);
    const fromC = c.insert(1, "y"); // parent is a's "x"
    const b = new Replica("b");
    expect(b.receive(fromC[0]!)).toBe("buffered");
    expect(b.receive(fromA[0]!)).toBe("applied");
    expect(b.toString()).toBe("xy");
  });

  it("buffers a delete until its target arrives", () => {
    const a = new Replica("a");
    const insert = a.insert(0, "x");
    const c = new Replica("c");
    c.receive(insert[0]!);
    const del = c.delete(0);
    const b = new Replica("b");
    expect(b.receive(del[0]!)).toBe("buffered");
    expect(b.receive(insert[0]!)).toBe("applied");
    expect(b.toString()).toBe("");
  });

  it("reports duplicates of both applied and buffered ops", () => {
    const a = new Replica("a");
    const ops = a.insert(0, "ab");
    const b = new Replica("b");
    expect(b.receive(ops[1]!)).toBe("buffered");
    expect(b.receive(ops[1]!)).toBe("duplicate");
    expect(b.receive(ops[0]!)).toBe("applied");
    expect(b.receive(ops[0]!)).toBe("duplicate");
    expect(b.toString()).toBe("ab");
  });

  it("applies any delivery order of a long history", () => {
    const a = new Replica("a");
    const ops: Op[] = [...a.insert(0, "hello world"), ...a.delete(2, 3), ...a.insert(4, "XY")];
    const b = new Replica("b");
    for (const op of [...ops].reverse()) b.receive(op);
    expect(b.toString()).toBe(a.toString());
    expect(b.pendingCount).toBe(0);
  });
});

describe("version-vector sync", () => {
  it("sends only the ops a peer is missing", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    a.insert(0, "abc");
    sync(a, b);
    a.insert(3, "d");
    expect(a.opsSince(b.versionVector()).map((op) => op.id.counter)).toEqual([4]);
    expect(a.opsSince(a.versionVector())).toEqual([]);
  });

  it("merges edits made while offline on both sides", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    a.insert(0, "shared text");
    sync(a, b);

    // Both edit while disconnected.
    a.insert(0, "A: ");
    a.delete(10, 2); // "A: shared xt"
    b.insert(11, "!");
    b.delete(0, 7); // "text!"

    sync(a, b);
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe("A: xt!");
    expect(a.versionVector()).toEqual(b.versionVector());
  });

  it("relays third-party ops it learned about", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const c = new Replica("c");
    a.insert(0, "from a");
    sync(a, b);
    sync(b, c); // c never talks to a directly
    expect(c.toString()).toBe("from a");
  });
});
