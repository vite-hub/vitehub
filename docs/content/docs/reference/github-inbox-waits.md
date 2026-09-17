---
title: Durable pull request waits
description: Park a pull request until structured host evidence changes.
---

Use `PullRequestInbox` from `vite-hub/agent/server/github-inbox` on a Node host.
A completed pass can persist `wait: { reason, evidenceKey }` through `finish()`.
The inbox binds it to the claim's head. `get()` and `summary()` expose the reason
and key after a restart. Delivery replay, pending checks, and unrelated events do
not admit another Agent invocation while an explicit wait exists.

The host owns the wake policy. Build `evidenceKey` from structured current-head
checks, review feedback, base and mergeability information that can require work.
Exclude delivery IDs, request timestamps and other transport metadata. Include
changed feedback and conflicts, not just CI, so a wait cannot hide new work.
Do not derive the key or waiting decision from an Agent's prose. A wait is an
admission decision; it does not authorize merging.

```ts
// After a pass, evaluate the claim's hydrated snapshot with host policy.
const decision = await evaluateEvidence(claim.snapshot)
if (decision.wait) {
  const finished = inbox.finish(claim, {
    text: 'Waiting for external evidence',
    wait: { reason: decision.reason, evidenceKey: decision.key },
  })
  // An intervening webhook makes this decision stale and requeues the work.
  if (!finished) scheduleReconciliation()
}

// Run after every verified webhook, before claiming work, and on host startup.
inbox.ingest(deliveryId, event, verifiedPayload)
for (const observed of inbox.all()) {
  if (!observed.wait) continue
  const decision = await evaluateEvidence(observed)
  inbox.wake(observed, decision.key)
}
const claims = inbox.claim(capacity)
```

`evaluateEvidence` is application policy, not an exported helper. It must include
the state of every wake condition and reconcile missing external evidence before
returning a key. Evaluate waits periodically when webhooks can be lost. A policy
version may be part of the key when deploying a new evaluator.

`wake()` returns `true` only when it releases a wait. An unchanged key or stale
snapshot returns `false`. Head, generation and evidence revision fence stale
results, including updates that do not start a new generation. Re-read and
re-evaluate after a stale result. `finish()` also rejects a stale explicit wait;
it releases its own lease and requeues eligible work without discarding new evidence.
An obsolete claim never releases a replacement owner’s lease.

A new PR head clears its old wait automatically. A closed PR becomes terminal.
Never set `retry` or `terminal` together with `wait`; the inbox rejects these
conflicting outcomes. Empty reasons and keys are invalid. Calls to `finish()`
without `wait` keep the default event-driven behavior.

This primitive does not evaluate GitHub branch protection, decide which reviews
matter, run a reconciliation timer, or cap retries. The host must run the evidence
loop; otherwise a same-head explicit wait remains parked.
