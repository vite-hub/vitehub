---
title: WebContainer limits and errors
description: What a WebContainer cannot run, and the errors that @vite-hub/web-container throws.
navigation.title: Limits and errors
navigation.order: 6
icon: i-lucide-triangle-alert
---

## Limits

- Node is 22.22.3 and cannot be changed. `engines` and `.nvmrc` are ignored.
- `node:sqlite` loads but has no `exec()` or `prepare()`. Use `@libsql/client` with a `file:` URL.
- workerd and Miniflare cannot run, so the Cloudflare preset cannot run locally in a container.
- Outbound `fetch()` from the app is subject to CORS from a StackBlitz origin. A blocked request fails with `SocketError: other side closed`.
- Spawned arguments lose backslashes. Mount a script file and run it instead of `node -e`.
- Only one container runs per page, and only one `run("dev")` may be active in it.
- The preview origin does not answer a `fetch()` from the page. Show it in an `<iframe>`.
- `createNodeModulesSnapshot()` requires Linux, macOS, or WSL. It rejects Windows before it changes files, because npm's Windows command shims cannot be restored as POSIX bin links.

## Errors

### `WebContainerUnsupportedError`

`bootWebContainer()` throws it when the page cannot run a WebContainer. Its message is the `reason` of `checkWebContainerSupport()`. The usual cause is a page that is not cross-origin isolated. Send the [isolation headers](/docs/web-container/configure#set-the-headers-in-production) on that route.

### `SnapshotLockfileMismatchError`

`createNodeModulesSnapshot()` throws it when the `lockfile` that you pass no longer matches the dependencies of the app, or misses the wasm aliases. Pass `frozenLockfile: false` to update the lockfile, then keep the new one. Other install and snapshot errors propagate unchanged.

### `RangeError: Offset is outside the bounds of the DataView`

One container failed with this error after two full ViteHub installs. Use one container for each app, and call `teardown()` before you boot the next.

### A second `run("dev")` rejects

Only one `dev` run may be active, also while it spawns. Call `kill()` on the first run and await its `exit` before you start it again.
