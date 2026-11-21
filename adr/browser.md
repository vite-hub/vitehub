# @vite-hub/browser decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Browser: roll back before releasing the provider, and reject idleTimeoutMs locally

`BrowserClient close`, `localBrowser` in `packages/browser/src/client.ts`, `packages/browser/src/providers/local.ts`.

**Context:** Rollback talks to the provider; nothing reaps a local Chromium.

**Decision:** Await rollback before closing; reject idleTimeoutMs on localBrowser.

**Consequences:** Reordering loses rollback; ignoring the option would hide a limit.

## BrowserRunErrorCodes is a type alias

`BrowserRunErrorCodes` in `packages/browser/src/run-errors.ts`.

**Context:** Interfaces do not satisfy index signatures.

**Decision:** Use type, not interface.

**Consequences:** An interface breaks typecheck.
