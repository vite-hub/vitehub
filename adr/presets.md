# Presets decisions

## Report reconcile liveness without blocking the health endpoint

`boundedHealthRead` in `packages/presets/src/babysitter/host.ts` and scheduler health in `packages/presets/src/babysitter/server.ts`.

**Context:** A stalled dependency can delay both the reconcile and a health read that checks the reconcile.

**Decision:** Bound the health read's wait and reuse the pending read until it settles. Count a completed reconcile as progress even when it fails. Do not report silence while the host is drained.

**Consequences:** Health can report a stall without starting more reads against a busy dependency. `admission.lastSkip` remains available to existing clients as historical data, not current admission state.
