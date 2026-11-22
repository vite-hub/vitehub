# @vite-hub/web-container decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Reload when crossing the isolation boundary in Nuxt

`addWebContainerBoundaryPlugin` in `packages/vite-hub/src/nuxt.ts`.

**Context:** Cross-origin isolation is set by the document headers, not by client-side route state.

**Decision:** Reload on navigation between matched WebContainer routes and other routes, but not on the initial navigation.

**Consequences:** Containers can boot on isolated pages without imposing isolation on the rest of the site.

## WebContainer: host-neutral shared files, path resolution, pipeTo drain, wasm swaps

`links module`, `webContainerErrorDiagnostics`, `process output drain`, `wasm swap list` in `packages/web-container/src/links.ts`, `packages/web-container/src/error-diagnostics.ts`, `packages/web-container/src/index.ts`, `packages/web-container/src/snapshot.ts`.

**Context:** Node and browser share files; normalizing first hides escapes; tee buffers without bound; npm in WebContainer swaps wasm builds.

**Decision:** No imports in links.ts; follow each path component; pipeTo for the drain; snapshot the wasm builds and preinstall the rolldown binding.

**Consequences:** No path escape; bounded memory; the swap list must follow npm.
