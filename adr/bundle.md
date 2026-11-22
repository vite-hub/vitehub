# @vite-hub/bundle decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Bundle reports: startup rule blame, Cloudflare limit, bundled vue-router

`startup rule target`, `cloudflareWorkerSizeLimit`, `alwaysBundle` in `packages/bundle/src/checks.ts`, `packages/bundle/src/diagnostics.ts`, `packages/bundle/vite.config.ts`.

**Context:** Rule packages are listed app-import first; the limit comes from Cloudflare docs; routes.ts imports vue-router.

**Decision:** Order rule.packages app-import first; compare uncompressed bytes to 64 MiB; always bundle vue-router.

**Consequences:** Wrong order blames the wrong package; recheck the limit when Cloudflare changes it.

## Operations entries are imported by path, not exported

`operations entries`, `operationsModule`, `privateEntries` in `packages/bundle/vite.config.ts`, `packages/email/src/vite.ts`, `packages/email/vite.config.ts`.

**Context:** Generated code imports these modules by file path.

**Decision:** Build these entries but keep them out of package exports.

**Consequences:** They are not public API.
