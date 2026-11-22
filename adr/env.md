# @vite-hub/env decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Diagnostic fix text must be a string literal

`withFix` in `packages/env/src/error-diagnostics.ts`.

**Context:** helperText() in docs/modules/diagnostics/catalog.ts reads fix text statically.

**Decision:** Fix arguments are always literals.

**Consequences:** A computed fix does not appear in the docs.

## Env security and ordering rules

`createEnvAuthenticator`, `createStageModuleLoader`, `runtimeSchemaParsers`, `createSourceContext`, `runtime`, `createSealUses`, `createSealing.unseal`, `seal TextDecoder`, `missingRuntimeValueMessage`, `checkServiceToken`, `verifyWebhook`, `RESOLVED_PUBLIC_ID`, `resolveDevelopmentSecretUnlocked`, `peerDependenciesMeta` in `packages/env/src/auth.ts`, `packages/env/src/cli.ts`, `packages/env/src/core/declarations.ts`, `packages/env/src/core/resolve.ts`, `packages/env/src/operations.ts`, `packages/env/src/seal-uses.ts`, `packages/env/src/seal-value.ts`, `packages/env/src/seal.ts`, `packages/env/src/server.ts`, `packages/env/src/service-token.ts`, `packages/env/src/webhook.ts`, `packages/env/src/vite.ts`, `packages/env/test/build-graph.test.ts`.

**Context:** Auth, sealing, secret handling, timing, Vite dev URLs, lock files, build graph.

**Decision:** Bearer never falls back to the cookie; schemas keyed by function; branch only from refs/heads; lazy runtime import; checked-only SQL text; unseal order derive, authenticate, database, decrypt, expiry, use; keep the BOM; secrets get no default hint, enum list, or issue text; constant-time compare over all tokens; no # in the browser id; take stale locks by rename; Agent is an optional peer.

**Consequences:** Reverting any of these opens a security or correctness gap.
