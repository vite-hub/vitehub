# @vite-hub/webhooks decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Webhooks delivery ordering and safety; lazy operations

`claim update`, `debounce delay`, `wake replacement`, `fetch redirect: manual`, `operations` in `packages/webhooks/src/database.ts`, `packages/webhooks/src/runtime.ts`, `packages/webhooks/src/operations.ts`.

**Context:** Concurrent sends, whole-second Queue delays, Queue restarts, signed bodies, CLI listing outside Nitro.

**Decision:** Single-statement claim; round delays up; replace the wake before ack; never follow redirects; lazy runtime; user: false.

**Consequences:** No claim race, no wasted retries, no signed body to a redirect target.
