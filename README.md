# Weave

A real-time collaborative text editor built on a hand-written
[Fugue](https://arxiv.org/abs/2305.00583) sequence CRDT. Concurrent edits from
any number of replicas merge deterministically, even when messages arrive out
of order, arrive twice, or are made while offline.

## Repository layout

| Path | What it is |
| --- | --- |
| [`crdt/`](crdt) | The CRDT in TypeScript: Fugue tree, causal buffer, op log, version-vector sync. No dependencies. |
| [`client/`](client) | Browser client: CodeMirror 6 bound to the CRDT, plus a local three-editor demo. |

Planned: a Java/Spring Boot WebSocket relay with PostgreSQL op logs and
snapshots, and benchmarks against Yjs and Automerge.

## Getting started

Requires Node.js 22+. Run everything from the repository root.

```bash
npm install
npm test            # unit tests + 1,000 randomized convergence histories
npm run typecheck   # both packages
npm run dev         # demo at http://localhost:5173
```

## The demo

Three editors (Alice, Bob, Carol), each with its own replica, connected by a
simulated network that gives every message a random delay, so messages overtake
each other. Things to try:

- **Concurrent typing:** drag latency up, then type in two editors at the same
  spot. The words land side by side, never interleaved letter by letter.
- **Offline editing:** untick "online" for one editor, edit it and another,
  then tick it again. Version-vector sync exchanges the missing ops and every
  replica converges.
- **Undo:** Ctrl+Z only undoes your own edits, never someone else's.

Each panel shows its version vector, how many early ops are buffered, and
whether the editor text matches the CRDT. The badge on top says whether all
replicas are identical.

## Testing

The core guarantee is checked by property-based testing with
[fast-check](https://fast-check.dev/): random histories of 2–5 replicas
editing over a network that reorders, duplicates and drops messages, with
replicas going offline and syncing. After the network heals, every replica
must hold identical text, no edit may be lost or resurrected, and every
reported change position must be correct.

To run more histories, or replay a failing seed (PowerShell shown):

```powershell
cd crdt
$env:WEAVE_PBT_RUNS = "10000"; npx vitest run test/convergence.property.test.ts
$env:WEAVE_PBT_SEED = "<seed from failure>"; npx vitest run test/convergence.property.test.ts
```
