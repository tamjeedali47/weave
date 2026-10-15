import { describe, expect, it } from "vitest";
import { FugueDoc, type Op } from "../src/index.js";

function applyAll(doc: FugueDoc, ops: readonly Op[]): void {
  for (const op of ops) doc.apply(op);
}

/** Two replicas that both start from `base`, as typed by a third replica. */
function replicasFrom(base: string): [FugueDoc, FugueDoc] {
  const origin = new FugueDoc("origin");
  const ops = origin.insert(0, base);
  const alice = new FugueDoc("alice");
  const bob = new FugueDoc("bob");
  applyAll(alice, ops);
  applyAll(bob, ops);
  return [alice, bob];
}

describe("local editing", () => {
  it("starts empty", () => {
    const doc = new FugueDoc("a");
    expect(doc.toString()).toBe("");
    expect(doc.length).toBe(0);
  });

  it("inserts at the start, middle and end", () => {
    const doc = new FugueDoc("a");
    doc.insert(0, "ac");
    doc.insert(1, "b");
    doc.insert(0, ">");
    doc.insert(4, "<");
    expect(doc.toString()).toBe(">abc<");
    expect(doc.length).toBe(5);
  });

  it("deletes ranges", () => {
    const doc = new FugueDoc("a");
    doc.insert(0, "hello world");
    doc.delete(5, 6);
    expect(doc.toString()).toBe("hello");
    expect(doc.length).toBe(5);
  });

  it("inserts next to tombstones", () => {
    const doc = new FugueDoc("a");
    doc.insert(0, "abc");
    doc.delete(1);
    doc.insert(1, "X");
    expect(doc.toString()).toBe("aXc");
  });

  it("rejects out-of-range positions", () => {
    const doc = new FugueDoc("a");
    doc.insert(0, "x");
    expect(() => doc.insert(2, "y")).toThrow(RangeError);
    expect(() => doc.insert(-1, "y")).toThrow(RangeError);
    expect(() => doc.delete(1)).toThrow(RangeError);
    expect(() => doc.delete(0, 2)).toThrow(RangeError);
  });

  it("numbers its operations 1, 2, 3, ... with no gaps", () => {
    const doc = new FugueDoc("a");
    const ops = [...doc.insert(0, "ab"), ...doc.insert(0, ""), ...doc.delete(0)];
    expect(ops.map((op) => op.id)).toEqual([
      { replica: "a", counter: 1 },
      { replica: "a", counter: 2 },
      { replica: "a", counter: 3 },
    ]);
    expect(doc.versionVector()).toEqual({ a: 3 });
  });
});

describe("replication", () => {
  it("reproduces the text when ops are replayed on another replica", () => {
    const a = new FugueDoc("a");
    const ops = [
      ...a.insert(0, "hello world"),
      ...a.delete(0, 6),
      ...a.insert(5, "!"),
      ...a.insert(0, "big "),
    ];
    const b = new FugueDoc("b");
    applyAll(b, ops);
    expect(b.toString()).toBe("big world!");
    expect(b.toString()).toBe(a.toString());
    expect(b.versionVector()).toEqual(a.versionVector());
  });

  it("ignores duplicate deliveries", () => {
    const a = new FugueDoc("a");
    const ops = [...a.insert(0, "ab"), ...a.delete(0)];
    const b = new FugueDoc("b");
    expect(ops.map((op) => b.apply(op))).toEqual([true, true, true]);
    expect(ops.map((op) => b.apply(op))).toEqual([false, false, false]);
    expect(b.toString()).toBe("b");
  });

  it("refuses ops that arrive before their predecessor", () => {
    const a = new FugueDoc("a");
    const ops = a.insert(0, "ab");
    const b = new FugueDoc("b");
    expect(() => b.apply(ops[1]!)).toThrow(/not ready/);
    expect(b.toString()).toBe("");
  });

  it("refuses inserts whose parent is unknown", () => {
    const b = new FugueDoc("b");
    const op: Op = {
      type: "insert",
      id: { replica: "a", counter: 1 },
      parent: { replica: "z", counter: 1 },
      side: "R",
      char: "x",
    };
    expect(() => b.apply(op)).toThrow(/parent .* missing/);
    expect(b.versionVector()).toEqual({});
  });
});

describe("concurrent edits", () => {
  it("does not interleave words typed forwards at the same position", () => {
    const [alice, bob] = replicasFrom("[]");
    const fromAlice = alice.insert(1, "hello");
    const fromBob = bob.insert(1, "world");
    applyAll(alice, fromBob);
    applyAll(bob, fromAlice);
    expect(alice.toString()).toBe(bob.toString());
    expect(["[helloworld]", "[worldhello]"]).toContain(alice.toString());
  });

  it("does not interleave words typed backwards at the same position", () => {
    // Each character is typed at the start, like pressing Home before every key.
    const alice = new FugueDoc("alice");
    const bob = new FugueDoc("bob");
    const fromAlice = [..."cba"].flatMap((c) => alice.insert(0, c));
    const fromBob = [..."zyx"].flatMap((c) => bob.insert(0, c));
    expect(alice.toString()).toBe("abc");
    applyAll(alice, fromBob);
    applyAll(bob, fromAlice);
    expect(alice.toString()).toBe(bob.toString());
    expect(["abcxyz", "xyzabc"]).toContain(alice.toString());
  });

  it("converges when both replicas delete the same character", () => {
    const [alice, bob] = replicasFrom("abc");
    const fromAlice = alice.delete(1);
    const fromBob = bob.delete(1);
    applyAll(alice, fromBob);
    applyAll(bob, fromAlice);
    expect(alice.toString()).toBe("ac");
    expect(bob.toString()).toBe("ac");
    expect(alice.length).toBe(2);
    expect(bob.length).toBe(2);
  });

  it("keeps an insert whose neighbour was concurrently deleted", () => {
    const [alice, bob] = replicasFrom("abc");
    const fromAlice = alice.delete(1); // deletes "b"
    const fromBob = bob.insert(2, "X"); // types right after "b"
    applyAll(alice, fromBob);
    applyAll(bob, fromAlice);
    expect(alice.toString()).toBe("aXc");
    expect(bob.toString()).toBe("aXc");
  });

  it("converges regardless of which replica's ops are applied first", () => {
    const [alice, bob] = replicasFrom("0123456789");
    const fromAlice = [...alice.insert(3, "AA"), ...alice.delete(6, 2), ...alice.insert(0, "a")];
    const fromBob = [...bob.delete(2, 3), ...bob.insert(4, "BB"), ...bob.insert(9, "b")];
    const carol = new FugueDoc("carol");
    const dave = new FugueDoc("dave");
    const base = new FugueDoc("origin").insert(0, "0123456789");
    applyAll(carol, [...base, ...fromAlice, ...fromBob]);
    applyAll(dave, [...base, ...fromBob, ...fromAlice]);
    applyAll(alice, fromBob);
    applyAll(bob, fromAlice);
    const texts = [alice, bob, carol, dave].map((d) => d.toString());
    expect(new Set(texts).size).toBe(1);
  });
});

describe("large documents", () => {
  it("handles a 100k-character document without overflowing the stack", () => {
    const a = new FugueDoc("a");
    const text = "x".repeat(100_000);
    const ops = a.insert(0, text);
    expect(a.toString()).toBe(text);
    const b = new FugueDoc("b");
    applyAll(b, ops);
    expect(b.toString()).toBe(text);
  });
});
