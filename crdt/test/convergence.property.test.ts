import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { idKey, Replica, type Op, type ReceiveResult } from "../src/index.js";

/**
 * Randomized convergence testing.
 *
 * fast-check generates whole editing histories: replicas typing and deleting,
 * a network that delivers messages in any order, duplicates some, and loses
 * messages to replicas that are offline, plus replicas going offline and
 * syncing on reconnect. At the end the network heals and every replica must
 * hold the same text with no edit lost or resurrected.
 *
 * WEAVE_PBT_RUNS sets the number of histories; WEAVE_PBT_SEED replays a seed
 * that fast-check printed for a failure.
 */
const NUM_RUNS = Number(process.env.WEAVE_PBT_RUNS ?? 1_000);
const SEED = process.env.WEAVE_PBT_SEED === undefined ? undefined : Number(process.env.WEAVE_PBT_SEED);

type Command =
  | { kind: "insert"; replica: number; at: number; text: string }
  | { kind: "delete"; replica: number; at: number; count: number }
  | { kind: "deliver"; message: number; duplicate: boolean }
  | { kind: "toggleOnline"; replica: number }
  | { kind: "sync"; a: number; b: number; reverse: boolean };

// Indices are unbounded naturals reduced modulo the current size when run, so
// any generated command is valid and shrinking towards 0 stays meaningful.
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("insert" as const),
      replica: fc.nat(),
      at: fc.nat(),
      text: fc.string({ unit: fc.constantFrom("a", "b", "c"), minLength: 1, maxLength: 4 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      replica: fc.nat(),
      at: fc.nat(),
      count: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("deliver" as const),
      message: fc.nat(),
      duplicate: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("toggleOnline" as const), replica: fc.nat() }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("sync" as const),
      a: fc.nat(),
      b: fc.nat(),
      reverse: fc.boolean(),
    }),
  },
);

const historyArb = fc.record({
  replicaCount: fc.integer({ min: 2, max: 5 }),
  // size "max": fast-check otherwise biases towards very short histories.
  commands: fc.array(commandArb, { minLength: 10, maxLength: 200, size: "max" }),
});

/** Totals across all histories, printed at the end as evidence of coverage. */
const stats = {
  histories: 0,
  localOps: 0,
  offlineOps: 0,
  delivered: 0,
  buffered: 0,
  duplicates: 0,
  dropped: 0,
  syncs: 0,
  maxBuffered: 0,
};

interface Message {
  readonly to: number;
  readonly op: Op;
}

class Simulation {
  private readonly replicas: Replica[];
  private readonly online: boolean[];
  private inFlight: Message[] = [];
  private insertedCount = 0;
  private readonly deletedTargets = new Set<string>();

  constructor(count: number) {
    this.replicas = Array.from({ length: count }, (_, i) => new Replica(`r${i}`));
    this.online = this.replicas.map(() => true);
  }

  run(command: Command): void {
    const n = this.replicas.length;
    switch (command.kind) {
      case "insert":
        return this.insert(command.replica % n, command.at, command.text);
      case "delete":
        return this.delete(command.replica % n, command.at, command.count);
      case "deliver":
        return this.deliver(command.message, command.duplicate);
      case "toggleOnline":
        return this.toggleOnline(command.replica % n);
      case "sync":
        return this.sync(command.a % n, command.b % n, command.reverse);
    }
  }

  /** Brings everyone online, syncs all pairs, then flushes stale messages. */
  heal(): void {
    this.online.fill(true);
    // Pass 1 gathers everything into replica 0; pass 2 hands it back out.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < this.replicas.length; i++) this.sync(0, i, pass === 1);
    }
    // Everything still in flight is now a duplicate and must be harmless.
    while (this.inFlight.length > 0) this.deliver(0, false);
  }

  checkConverged(): void {
    const [first, ...rest] = this.replicas;
    for (const replica of rest) {
      expect(replica.toString()).toBe(first!.toString());
      expect(replica.versionVector()).toEqual(first!.versionVector());
    }
    for (const replica of this.replicas) {
      expect(replica.pendingCount).toBe(0);
      expect(replica.length).toBe(replica.toString().length);
      // Nothing lost, nothing resurrected: every insert is visible unless deleted.
      expect(replica.length).toBe(this.insertedCount - this.deletedTargets.size);
    }
  }

  private insert(r: number, at: number, text: string): void {
    const replica = this.replicas[r]!;
    const before = replica.toString();
    const index = at % (before.length + 1);
    const ops = replica.insert(index, text);
    // Local edits must do exactly what a plain string would.
    expect(replica.toString()).toBe(before.slice(0, index) + text + before.slice(index));
    this.insertedCount += ops.length;
    this.broadcast(r, ops);
  }

  private delete(r: number, at: number, count: number): void {
    const replica = this.replicas[r]!;
    const before = replica.toString();
    if (before.length === 0) return;
    const index = at % before.length;
    const clamped = Math.min(count, before.length - index);
    const ops = replica.delete(index, clamped);
    expect(replica.toString()).toBe(before.slice(0, index) + before.slice(index + clamped));
    for (const op of ops) this.deletedTargets.add(idKey(op.target));
    this.broadcast(r, ops);
  }

  private broadcast(from: number, ops: readonly Op[]): void {
    stats.localOps += ops.length;
    // An offline replica's ops stay in its log until a sync sends them.
    if (!this.online[from]) {
      stats.offlineOps += ops.length;
      return;
    }
    for (let to = 0; to < this.replicas.length; to++) {
      if (to === from) continue;
      for (const op of ops) this.inFlight.push({ to, op });
    }
  }

  private deliver(message: number, duplicate: boolean): void {
    if (this.inFlight.length === 0) return;
    const index = message % this.inFlight.length;
    const { to, op } = this.inFlight[index]!;
    if (!duplicate) this.inFlight.splice(index, 1);
    if (!this.online[to]) {
      stats.dropped++;
      return;
    }
    this.receive(to, op);
  }

  private toggleOnline(r: number): void {
    this.online[r] = !this.online[r];
    if (!this.online[r]) return;
    // On reconnect, catch up with one online peer (others may still be behind).
    const peer = this.online.findIndex((up, i) => up && i !== r);
    if (peer !== -1) this.sync(r, peer, false);
  }

  /** Two-way version-vector sync, optionally delivering ops newest-first. */
  private sync(a: number, b: number, reverse: boolean): void {
    if (a === b || !this.online[a] || !this.online[b]) return;
    stats.syncs++;
    const ra = this.replicas[a]!;
    const rb = this.replicas[b]!;
    const toB = ra.opsSince(rb.versionVector());
    const toA = rb.opsSince(ra.versionVector());
    if (reverse) {
      toB.reverse();
      toA.reverse();
    }
    for (const op of toB) this.receive(b, op);
    for (const op of toA) this.receive(a, op);
  }

  private receive(to: number, op: Op): void {
    const replica = this.replicas[to]!;
    const result: ReceiveResult = replica.receive(op);
    stats.delivered++;
    if (result === "buffered") stats.buffered++;
    if (result === "duplicate") stats.duplicates++;
    stats.maxBuffered = Math.max(stats.maxBuffered, replica.pendingCount);
  }
}

describe("convergence under an unreliable network", () => {
  it(`converges across ${NUM_RUNS} randomized edit histories`, () => {
    fc.assert(
      fc.property(historyArb, ({ replicaCount, commands }) => {
        stats.histories++;
        const sim = new Simulation(replicaCount);
        for (const command of commands) sim.run(command);
        sim.heal();
        sim.checkConverged();
      }),
      { numRuns: NUM_RUNS, ...(SEED === undefined ? {} : { seed: SEED }) },
    );
  }, Math.max(10_000, NUM_RUNS * 5)); // ~1ms per history; leave ample headroom.

  afterAll(() => {
    console.log("convergence stats:", stats);
  });
});
