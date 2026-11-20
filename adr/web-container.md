# @vite-hub/web-container decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## WebContainer: host-neutral shared files, path resolution, pipeTo drain, wasm swaps

`links module`, `webContainerErrorDiagnostics`, `process output drain`, `wasm swap list` in `packages/web-container/src/links.ts`, `packages/web-container/src/error-diagnostics.ts`, `packages/web-container/src/index.ts`, `packages/web-container/src/snapshot.ts`.

**Context:** Node and browser share files; normalizing first hides escapes; tee buffers without bound; npm in WebContainer swaps wasm builds.

**Decision:** No imports in links.ts; follow each path component; pipeTo for the drain; snapshot the wasm builds and preinstall the rolldown binding.

**Consequences:** No path escape; bounded memory; the swap list must follow npm.
