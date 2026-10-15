import type { Op, Replica } from "@weave/crdt";
import type { EditorBinding } from "./binding.js";

export interface Peer {
  readonly name: string;
  readonly replica: Replica;
  readonly binding: EditorBinding;
  online: boolean;
}

/**
 * An in-page stand-in for the server, used until the Spring Boot backend
 * exists. It is deliberately unreliable in the ways a real network is:
 *
 * - Every message gets its own random delay, so messages overtake each other
 *   and replicas must buffer ops that arrive early.
 * - Messages to an offline peer are dropped, and an offline peer's edits are
 *   never broadcast. Both are recovered by version-vector sync on reconnect.
 */
export class DemoNetwork {
  readonly peers: Peer[] = [];
  minLatencyMs = 0;
  maxLatencyMs = 0;
  inFlight = 0;
  dropped = 0;
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  add(peer: Peer): void {
    this.peers.push(peer);
  }

  broadcast(from: Peer, ops: readonly Op[]): void {
    if (from.online) {
      for (const to of this.peers) {
        if (to !== from) this.send(to, ops);
      }
    }
    this.onChange();
  }

  setOnline(peer: Peer, online: boolean): void {
    peer.online = online;
    if (online) {
      // Reconnect: swap version vectors with every online peer and send each
      // side exactly what the other is missing.
      for (const other of this.peers) {
        if (other === peer || !other.online) continue;
        const toPeer = other.replica.opsSince(peer.replica.versionVector());
        const toOther = peer.replica.opsSince(other.replica.versionVector());
        peer.binding.receive(toPeer);
        other.binding.receive(toOther);
      }
    }
    this.onChange();
  }

  private send(to: Peer, ops: readonly Op[]): void {
    const delay = this.minLatencyMs + Math.random() * (this.maxLatencyMs - this.minLatencyMs);
    this.inFlight++;
    setTimeout(() => {
      this.inFlight--;
      if (to.online) to.binding.receive(ops);
      else this.dropped++;
      this.onChange();
    }, delay);
  }
}
