# @vite-hub/gateways decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Gateways: explicit undefined credentials fail; Jev retry rule; public diagnostics allowlist

`missingSecret`, `preset`, `cloudflareAccess`, `requestJevWithRetry`, `publicCodes` in `packages/gateways/src/definition.ts`, `packages/gateways/src/presets.ts`, `packages/gateways/src/jev.ts`, `packages/gateways/src/public-diagnostics.ts`.

**Context:** Unset Server Env values arrive as undefined; transport and decode errors are both TypeErrors; some diagnostics carry provider bodies.

**Decision:** A present key wins even when undefined; retry only a TypeError with a cause; only allowlisted codes are public.

**Consequences:** No silent use of another account; decode errors fail fast; new codes stay private until listed.
