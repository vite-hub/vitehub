# @vite-hub/cms decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## CMS keeps the Content codes

`CMS error catalog` in `packages/cms/src/error-diagnostics.ts`.

**Context:** CMS declares CONTENT_* codes.

**Decision:** CMS reuses the Content codes.

**Consequences:** CMS errors open the Content docs pages.

## CMS: namespace imports for optional better-auth; flatten plugins before hooks

`access.ts imports`, `pluginsWithoutCms` in `packages/cms/src/access.ts`, `packages/cms/src/vite.ts`.

**Context:** Vite stubs missing optional peers; vitehub() nests plugins.

**Decision:** Use import * as; flatten then drop the CMS plugin.

**Consequences:** Named imports break apps without better-auth; no flatten means hook recursion.
