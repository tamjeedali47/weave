import { EditorView, placeholder } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { Replica } from "@weave/crdt";
import { EditorBinding } from "./binding.js";
import { DemoNetwork, type Peer } from "./demo-network.js";

const PEER_NAMES = ["alice", "bob", "carol"] as const;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing #${id}`);
  return found as T;
}

let refreshQueued = false;
const network = new DemoNetwork(() => {
  // Many events can fire in quick succession (one per delivered message);
  // redraw at most every 50ms. A timer rather than requestAnimationFrame,
  // which browsers pause while the page is hidden.
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refresh();
  }, 50);
});

const statusElements = new Map<Peer, HTMLElement>();

for (const name of PEER_NAMES) {
  const panel = document.createElement("section");
  panel.className = `peer peer-${name}`;
  panel.innerHTML = `
    <div class="peer-header">
      <h2>${name}</h2>
      <label class="toggle"><input type="checkbox" checked /> online</label>
    </div>
    <div class="editor"></div>
    <div class="peer-status"></div>`;
  element("peers").append(panel);

  const replica = new Replica(name);
  // Assigned right after construction; only called on edits, which come later.
  let peer: Peer;
  const binding = new EditorBinding({
    replica,
    parent: panel.querySelector<HTMLElement>(".editor")!,
    extensions: [minimalSetup, EditorView.lineWrapping, placeholder(`Type as ${name}…`)],
    onLocalOps: (ops) => network.broadcast(peer, ops),
  });
  peer = { name, replica, binding, online: true };
  network.add(peer);
  statusElements.set(peer, panel.querySelector<HTMLElement>(".peer-status")!);

  const toggle = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  toggle.addEventListener("change", () => {
    panel.classList.toggle("offline", !toggle.checked);
    network.setOnline(peer, toggle.checked);
  });
}

const latency = element<HTMLInputElement>("latency");
function applyLatency(): void {
  const max = Number(latency.value);
  // A spread of delays (not a fixed one) is what makes messages overtake each other.
  network.minLatencyMs = max / 4;
  network.maxLatencyMs = max;
  element("latency-value").textContent = `${max / 4}–${max} ms`;
}
latency.addEventListener("input", applyLatency);
applyLatency();

function refresh(): void {
  for (const [peer, status] of statusElements) {
    const editorText = peer.binding.view.state.doc.toString();
    const inSync = editorText === peer.replica.toString();
    const vv = Object.entries(peer.replica.versionVector())
      .map(([replica, counter]) => `${replica}:${counter}`)
      .join(" ");
    status.innerHTML = `
      <span title="Highest op counter applied from each replica">version vector: ${vv || "—"}</span>
      <span title="Ops received before the ops they depend on">buffered: ${peer.replica.pendingCount}</span>
      <span class="${inSync ? "ok" : "bad"}" title="Editor text matches the CRDT's text">
        editor ↔ CRDT ${inSync ? "match" : "MISMATCH"}
      </span>`;
  }

  const texts = network.peers.map((peer) => peer.replica.toString());
  const allOnline = network.peers.every((peer) => peer.online);
  const identical = texts.every((text) => text === texts[0]);
  const badge = element("convergence");
  if (identical) {
    badge.textContent = "✓ All replicas identical";
    badge.className = "badge ok";
  } else if (!allOnline || network.inFlight > 0) {
    badge.textContent = "… Replicas differ (waiting on network or offline replicas)";
    badge.className = "badge waiting";
  } else {
    // Everyone online and nothing in flight: replicas must have converged.
    badge.textContent = "✗ Replicas diverged — this is a bug";
    badge.className = "badge bad";
  }
  element("network-stats").textContent =
    `messages in flight: ${network.inFlight} · dropped while offline: ${network.dropped}`;
}

refresh();
