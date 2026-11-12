---
title: WebContainer API reference
description: Every export of @vite-hub/web-container, with its options and return values.
navigation.title: API reference
navigation.order: 5
icon: i-lucide-book-open
---

## `@vite-hub/web-container`

Runs in the browser. `vite-hub/web-container` re-exports it.

### `bootWebContainer(options?)`

Boots a WebContainer, mounts the snapshot and the files, and resolves with a container. Throws `WebContainerUnsupportedError` when the page cannot run one.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `files` | `Record<string, string \| Uint8Array>` | | Files to write into the working directory, keyed by a relative path such as `server/index.js`. |
| `snapshot` | `Uint8Array \| ArrayBuffer`, or a promise of one | | A binary snapshot from `container.export()`, `fetchSnapshot()`, or `createNodeModulesSnapshot()`. Mounted before `files`. A promise loads while the container boots. |
| `coep` | `"credentialless" \| "require-corp"` | `"credentialless"` | The Cross-Origin-Embedder-Policy of the page. |
| `workdirName` | `string` | | Folder name of the working directory. |
| `port` | `number` | `3000` | The port of the server to preview. `run()` passes it to every process as `PORT`. |
| `onStatus` | `(status) => void` | | Called on every status change, from the first check on. |

### The container

| Member | Description |
| --- | --- |
| `status` | The latest `stage`, every `steps` entry with `startedAt` and `ms`, and `error` when the stage is `unsupported` or `error`. |
| `preview.ready` | Resolves with `{ url, port }` when the server on `port`, or on the `env.PORT` of a run, is ready. Rejects on startup failure or teardown before readiness. |
| `preview.url`, `preview.port` | The latest server that became ready. |
| `fs` | The WebContainer file system API. |
| `run(command, options?)` | Starts a process. See below. |
| `export(options?)` | Resolves with a binary snapshot of the working directory. Options: `path`, `excludes`, `includes`. |
| `on("status", listener)` | Calls `listener` on every status change. Returns an unsubscribe function. |
| `on("server-ready", listener)` | Calls `listener` with `{ url, port }` for every server that becomes ready. Returns an unsubscribe function. |
| `teardown()` | Stops every process and frees the container. |

### `container.run(command, options?)`

`command` is `"install"` (`npm install`), `"dev"`, `"build"` (the npm scripts of the app), or an array such as `["node", "scripts/seed.js"]`.

| Option | Type | Description |
| --- | --- | --- |
| `env` | `Record<string, string>` | Environment variables for this process only. `PORT` defaults to the `port` of `bootWebContainer()`. |
| `cwd` | `string` | Working directory, relative to the container root. |
| `signal` | `AbortSignal` | Kills the process when aborted. |

The run has `output` (a `ReadableStream<string>` that you read once), `exit` (resolves with the exit code), `text()` (the last 65,536 characters of output after exit), `write(input)` (writes to stdin), and `kill()`.

### `checkWebContainerSupport()`

Returns `{ supported: true }`, or `{ supported: false, reason }` when the page is not cross-origin isolated, has no `SharedArrayBuffer`, or is not a browser page.

### `fetchSnapshot(urls, options?)`

Downloads the parts that `packSnapshot()` wrote, joins them in order, and inflates them. Pass the result, or the promise, to `bootWebContainer({ snapshot })`.

| Option | Type | Description |
| --- | --- | --- |
| `cache` | `string` | A Cache Storage name. Parts found there are not downloaded again. Parts of other URLs in this cache are deleted. |
| `sha256` | `string` | The SHA-256 of the joined parts, in hex. A snapshot that differs is rejected, and none of its parts is cached. |

### `toFileSystemTree(files)`

Turns `{ "server/index.js": "..." }` into the nested tree that a WebContainer mounts.

## `@vite-hub/web-container/vite`

| Export | Description |
| --- | --- |
| `hubWebContainer({ routes })` | A Vite plugin that sets the isolation headers on `routes` in `vite dev` and `vite preview`. Each route starts with `/`. `/playground` matches that path only, and `/playground/**` matches it and every path below it. Throws without a route. |
| `webContainerHeaders` | `{ "Cross-Origin-Embedder-Policy": "credentialless", "Cross-Origin-Opener-Policy": "same-origin" }`, for Nitro route rules in production. |
| `matchesWebContainerRoute(pathname, routes)` | Returns `true` when `pathname` matches one of the route patterns. |

## `@vite-hub/web-container/snapshot`

Runs in Node at build time, on Linux, macOS, or WSL.

### `createNodeModulesSnapshot(options)`

Installs the dependencies of an app as npm in a WebContainer does, and resolves with `{ snapshot, lockfile }`. `snapshot` holds only `node_modules`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `dir` | `string` | | A folder with the `package.json` (and `.npmrc`) of the app. |
| `dev` | `boolean` | `false` | Keep `devDependencies`. |
| `lockfile` | `string` | | The `lockfile` of an earlier snapshot. The install then runs `npm ci`. |
| `frozenLockfile` | `boolean` | `true` | With `false`, a `lockfile` that no longer matches the app is updated with `npm install` instead of an error. |

### `packSnapshot(data, options?)`

Compresses a snapshot with gzip and splits it into parts of at most `partBytes` (default 20 MiB).

## `@vite-hub/web-container/env`

`isWebContainer()` returns `true` when the code runs inside a WebContainer.

## `@vite-hub/web-container/connect`

`vite-hub/web-container/connect` re-exports it.

| Export | Description |
| --- | --- |
| `defineConnect(config)` | Describes the accounts that a page offers. Returns `{ providers }`, one entry for each provider with `name`, `kind`, `reach`, `auth`, and `env`. |
| `connectEnv(connect, credentials)` | Maps credentials keyed by provider name to the `env` variable of each provider. |

`config` takes `vercel` (`true` or `{ clientId }`), `github` (`true` or `{ app }`), `netlify`, `openai`, and `anthropic` (`true`), and `cloudflare` (`{ relay: "reader" }`). The [provider table](/docs/web-container/configure#describe-connectable-accounts) lists each `env` variable.
