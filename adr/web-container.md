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

## Describe OAuth providers and let the page run the flow

`defineConnect` in `packages/web-container/src/connect.ts`, read by `ConnectPanel` in `packages/ui/src/workspace/connect-panel.ts`.

**Context:** Vercel's OAuth and a GitHub App's user sign-in both exchange the code with a client secret, which cannot live in the browser tab or in the WebContainer.

**Decision:** `defineConnect` marks a provider `auth: "oauth"` when the page passes a Vercel `clientId` or a GitHub `app`. `ConnectPanel` emits `oauth` with that provider, and the page runs the flow with its own server, then stores the token like a pasted one.

**Consequences:** This package never handles a client secret. Removing the `oauth` mode also changes `ConnectPanel` and its `oauth` event.

## Turn off ExperimentalWarning for every run

The default `NODE_OPTIONS` of `run` in `bootWebContainer` in `packages/web-container/src/index.ts`.

**Context:** Vite loads the WASI build of Rolldown in a WebContainer, and Node warns on each load that WASI is experimental. Node emits that warning with no code, and `--disable-warning` matches only a code or a type, so it cannot turn off the WASI warning alone.

**Decision:** Pass `NODE_OPTIONS=--disable-warning=ExperimentalWarning` unless the run sets its own `NODE_OPTIONS`.

**Consequences:** Other experimental warnings are hidden too. It can narrow to a code when Node gives the WASI warning one, or go when Rolldown stops loading through WASI here.

## Install the wasm builds as optional aliases

`neededAliases` and the `optionalDependencies` written by `createNodeModulesSnapshot` in `packages/web-container/src/snapshot.ts`.

**Context:** npm 11 checks the platform of a required package against the host, and applies `--cpu`, `--os`, and `--libc` only to optional ones (`checkPlatform` in `@npmcli/arborist` `build-ideal-tree.js`). A required `@rolldown/binding-wasm32-wasi` (`cpu: wasm32`) fails with `EBADPLATFORM` on any real machine.

**Decision:** Write the wasm builds as aliased `optionalDependencies`, then copy them over the native packages.

**Consequences:** npm skips an optional package it cannot install without an error, so a missing wasm build shows up later, when the copy finds no alias. It can go when npm applies `--cpu` to required packages.

## Read npm's lockfile sync error from its message

The `npm ci` error check in `createNodeModulesSnapshot` in `packages/web-container/src/snapshot.ts`.

**Context:** `npm ci` reports a lockfile that does not match `package.json` as `EUSAGE`, the code it uses for every usage error, also with `--json`. Only the summary text says the lockfile is out of sync. A wrong match tells the caller to update a lockfile that is not stale.

**Decision:** Map the error to `WEB_CONTAINER_SNAPSHOT_LOCKFILE_MISMATCH` only when stderr has both `code EUSAGE` and npm's sync sentence. Any other failure propagates.

**Consequences:** If npm rewords the sentence, a stale lockfile fails with npm's own error instead of the mismatch diagnostic. It can go when npm gives this case its own code.

## Mark the lazy preview promise as handled

**Context:** A caller can save `app.preview.ready` and wait for `app.run("dev")` before awaiting it. A startup failure rejects both promises.

**Decision:** Attach a rejection handler when the preview promise is created. Return the original promise so awaiting it still reports the startup failure.

**Consequences:** A caller can handle startup first without triggering an unhandled rejection from preview readiness.
