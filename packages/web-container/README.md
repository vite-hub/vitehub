# @vite-hub/web-container

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fweb-container&icon=npm)](https://npmx.dev/package/@vite-hub/web-container)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fweb-container&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/web-container)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/web-container` runs a ViteHub app in the reader's browser tab, inside a [StackBlitz WebContainer](https://webcontainers.io). Docs tutorials and playgrounds use it to install, start, and preview an app without a server of ours.

Read the [WebContainer docs](https://vitehub.dev/docs/web-container) for a tutorial, snapshots, and the API reference.

Install this owner package directly, or import the same API from `vite-hub/web-container` when your app already uses the `vite-hub` framework distribution.

```sh
pnpm add @vite-hub/web-container
```

| Entry | Runs in | Use it to |
| --- | --- | --- |
| `@vite-hub/web-container` | Browser | Boot a container, mount files, run commands, read the preview |
| `@vite-hub/web-container/vite` | Vite config | Make the playground pages cross-origin isolated |
| `@vite-hub/web-container/env` | Any | Detect code that runs inside a WebContainer |
| `@vite-hub/web-container/connect` | Any | Describe which accounts a reader can connect, and map them to `env` |
| `@vite-hub/web-container/vue` | Browser, Vue | Run an app with `useWebContainer()` and keep its state in refs |

## Make the page cross-origin isolated

A WebContainer needs `SharedArrayBuffer`, so the page that boots it must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. Set these headers only on the pages that boot a container. Other pages keep cross-origin embeds, such as videos, working.

```ts
import { defineConfig } from "vite"
import { hubWebContainer } from "@vite-hub/web-container/vite"

export default defineConfig({
  plugins: [hubWebContainer({ routes: ["/playground/**"] })],
})
```

The plugin sets the headers in `vite dev` and `vite preview`. `/playground` matches that path only. `/playground/**` matches it and every path below it.

In production, set the same headers with Nitro route rules:

```ts fragment
import { webContainerHeaders } from "@vite-hub/web-container/vite"

export default defineNitroConfig({
  routeRules: {
    "/playground/**": { headers: webContainerHeaders },
  },
})
```

## Boot an app and open its preview

```ts
import { bootWebContainer } from "@vite-hub/web-container"

const container = await bootWebContainer({
  files: {
    "package.json": JSON.stringify({ type: "module", scripts: { dev: "node server.js" } }),
    "server.js": `import { createServer } from "node:http"
createServer((req, res) => res.end("Hello from " + process.version)).listen(process.env.PORT)`,
  },
})

await (await container.run("install")).exit
const dev = await container.run("dev")
dev.output.pipeTo(new WritableStream({ write: chunk => console.log(chunk) }))

const { url } = await container.preview.ready
document.querySelector("iframe")!.src = url
```

- `run("install")` runs `npm install`. `run("dev")` and `run("build")` run the npm scripts of the app. Pass an array, such as `run(["node", "scripts/seed.js"])`, to run any command line.
- Only one `run("dev")` may be active, including while it is spawning. Another call rejects until the process exits; call `kill()` and await `exit` before restarting it.
- A run returns `output` (a stream that you read once), `exit` (the exit code), `text()` (the last 65,536 output characters after exit), `write(input)`, and `kill()`. The stream buffers up to 65,536 characters and drops excess output until its reader catches up, so an idle terminal cannot accumulate unlimited logs. Pass `signal` to kill it with an `AbortController`.
- `container.preview.ready` resolves with the app server. It rejects if startup fails or the container is torn down before readiness. `run()` passes `PORT=3000` to every process, and `vite dev` with `vitehub()` and `node .output/server/index.mjs` listen on it. Only the server on that port becomes the preview, not the workers that Nitro starts on random ports first. Pass `bootWebContainer({ port })` to use another port, or `env: { PORT }` on one run. Read `url` from it, because the preview origin is not `localhost`. `run()` also passes `NODE_OPTIONS=--disable-warning=ExperimentalWarning`, because Vite loads the WASI build of Rolldown here and Node warns on each load. Pass your own `NODE_OPTIONS` to replace it.
- `container.on("server-ready", ({ url, port }) => …)` subscribes to every server readiness event, including custom commands and later restarts. It returns an unsubscribe function.
- Show the preview in an `<iframe>` on the same page. The preview origin does not answer a `fetch()` from the page.
- `container.fs` is the WebContainer file system API (`readFile`, `writeFile`, `readdir`, `mkdir`, `rm`, `watch`).
- Only one container runs per page. Call `container.teardown()` before you boot another.

### Render a boot checklist

Each status change carries the latest stage and every step so far, with its duration in milliseconds:

```ts fragment
const container = await bootWebContainer({
  files,
  onStatus: ({ stage, steps, error }) => renderChecklist(stage, steps, error),
})
container.on("status", status => renderChecklist(status.stage, status.steps, status.error))
```

The stages are `checking`, `unsupported`, `booting`, `mounting`, `installing`, `starting`, `ready`, and `error`. `installing` starts with `run("install")`. `starting` starts with `run("dev")` and becomes `ready` when the preview server is ready.

To show a notice before the reader clicks run, call `checkWebContainerSupport()`. It checks `crossOriginIsolated` and `SharedArrayBuffer`, not the browser name. `bootWebContainer()` throws `WebContainerUnsupportedError` with the same reason.

### Skip the install with a snapshot

An `npm install` of a ViteHub Agent app in a WebContainer takes minutes. Build the `node_modules` snapshot on your machine or in CI instead, and the container never installs:

```ts
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

// Node, at build time
import { createNodeModulesSnapshot, packSnapshot } from "@vite-hub/web-container/snapshot"

const lockfile = existsSync("app.package-lock.json") ? readFileSync("app.package-lock.json", "utf8") : undefined
// Runs `npm ci` in build/app with the lockfile, or `npm install` without one.
const { snapshot, lockfile: next } = await createNodeModulesSnapshot({ dir: "build/app", lockfile })
writeFileSync("app.package-lock.json", next) // keep it, so the next build installs the same versions
const parts = packSnapshot(snapshot) // gzip, split into parts of at most 20 MiB
const sha256 = createHash("sha256").update(Buffer.concat(parts)).digest("hex")
parts.forEach((part, index) => writeFileSync(`public/app-modules.${sha256.slice(0, 12)}.${index}.bin`, part))
```

```ts fragment
// Browser
import { bootWebContainer, fetchSnapshot } from "@vite-hub/web-container"

const container = await bootWebContainer({
  snapshot: fetchSnapshot(partUrls, { cache: "my-app-modules", sha256 }),
  files,
})
await container.run("dev")
```

`createNodeModulesSnapshot()` requires Linux, macOS, or WSL. It rejects Windows before changing files, because npm's Windows command shims cannot be restored as POSIX bin links. It installs as npm in a WebContainer does: it uses `--cpu=wasm32`, so no native binaries download, it swaps `esbuild`, `lightningcss`, and `@libsql/client` for their wasm builds, and it adds `@rolldown/binding-wasm32-wasi`, which rolldown otherwise downloads on first use. The wasm builds install as npm aliases in the same install, so the returned `lockfile` pins every version: pass it back and the install runs `npm ci`, and the same lockfile gives the same snapshot bytes. A lockfile that no longer matches the app throws `SnapshotLockfileMismatchError`; pass `frozenLockfile: false` to update it. Other install and snapshot errors propagate unchanged. The original `package.json` is restored exactly on success and failure. The integrity of `file:` tarballs is left out of the lockfile, because a rebuilt tarball changes it. Install scripts do not run, and source maps are left out. A snapshot cannot hold symlinks or executable bits, so it lists them, and `bootWebContainer()` restores them after the mount. Link and executable paths must stay inside the working directory, and so must link targets: the builder leaves out other links, and the restore step skips other entries, because the snapshot bytes come from the network.

`fetchSnapshot()` downloads the parts in parallel and inflates them. With `sha256`, it rejects parts whose hash differs. With `cache`, it keeps the parts in Cache Storage, so a later boot downloads nothing. A part goes into the cache only after the whole snapshot inflates and matches its hash; a damaged snapshot removes its parts from the cache, so the next boot downloads them again. Give each snapshot version its own URLs, such as names with a content hash, and each app its own cache name: parts of other URLs in that cache are deleted. `bootWebContainer()` boots while the snapshot loads.

To reuse a container's own install, `container.export()` returns a binary snapshot of the working directory. Pass `excludes` (glob patterns) to leave files out. `files` is mounted after the snapshot, so it can replace files from it.

Use one container for each app. One container failed with `RangeError: Offset is outside the bounds of the DataView` after two full ViteHub installs.

## Run it from Vue

`useWebContainer()` from `@vite-hub/web-container/vue` boots an app and keeps its state in Vue refs. The workspace parts of [`@vite-hub/ui/workspace`](../ui/README.md#run-an-app-in-the-browser) render that state. Only one WebContainer runs per page.

```ts
import { useWebContainer } from "@vite-hub/web-container/vue"

const app = useWebContainer({ files: { "package.json": "...", "server.js": "..." } })
```

- `useWebContainer({ files, snapshot?, install?, start?, port?, env?, immediate? })` boots when the component mounts, installs, and starts the dev server. Pass `snapshot: () => fetchSnapshot(urls)` with `install: false` to skip the install; the function runs only when the workspace boots. Only the server on `port` (default `3000`, given to the dev server as `PORT`), or on `env.PORT`, becomes the preview. Pass `port` when the dev server listens on another port. It returns `status`, `steps` (with timings), `support`, `failure` (`unsupported`, `boot`, `install`, or `server`, with the exit code), `files`, `modified`, `fs`, `previewUrl`, `logs`, and `online`.
- `setFiles(files, { mode: "merge" | "replace" })` writes to the container and rejects when a write fails. Edits made before the mount ends are written when it ends. `reset()` puts back the original files. `install()` runs the install again, and `restart()` restarts the dev server.
- `env` is read on each run, so pass a getter or a computed, such as `useConnectStore().env(connect)` from `@vite-hub/ui/workspace`.
- `logs` retains the latest output, up to 65,536 characters and 1,000 chunks. Older output is dropped. Its array carries an `offset` counting dropped characters; pass it directly to `WorkspaceTerminal` to keep writes incremental across rollover. Ordinary arrays still append by prefix and clear the terminal when replaced.

## Pass secrets per process

`run()` takes `env` for that process only. Nothing is stored in the container or sent to a ViteHub server:

```ts fragment
await container.run("dev", { env: { OPENAI_API_KEY: key } })
```

## Describe connectable accounts

`@vite-hub/web-container/connect` describes the accounts that a page offers. It runs no OAuth flow yet.

```ts fragment
import { connectEnv, defineConnect } from "@vite-hub/web-container/connect"

const connect = defineConnect({
  vercel: { clientId: "oac_..." }, // without clientId, the reader pastes a token
  github: true, // without { app }, the reader pastes a fine-grained token
  netlify: true,
  openai: true,
  anthropic: true,
  cloudflare: { relay: "reader" }, // the Cloudflare API has no CORS, so calls go through a relay that the reader deploys
})

await container.run("dev", { env: connectEnv(connect, { openai: key }) })
```

Each provider has a `kind` (`deploy`, `source`, or `model`), a `reach` (`browser` or `relay`), an `auth` (`oauth` or `token`), and the `env` variable that receives the credential.

| Provider | Kind | Reach | Env |
| --- | --- | --- | --- |
| `anthropic` | model | browser | `ANTHROPIC_API_KEY` |
| `cloudflare` | deploy | relay | `CLOUDFLARE_API_TOKEN` |
| `github` | source | browser | `GITHUB_TOKEN` |
| `netlify` | deploy | browser | `NETLIFY_AUTH_TOKEN` |
| `openai` | model | browser | `OPENAI_API_KEY` |
| `vercel` | deploy | browser | `VERCEL_TOKEN` |

## Detect a WebContainer

```ts
import { isWebContainer } from "@vite-hub/web-container/env"

const driver = isWebContainer() ? "libsql" : "sqlite"
```

Primitive packages use this to choose a driver that works in a WebContainer.

## Limits

- Node is 22.22.3 and cannot be changed. `engines` and `.nvmrc` are ignored.
- `node:sqlite` loads but has no `exec()` or `prepare()`. Use `@libsql/client` with a `file:` URL.
- workerd and Miniflare cannot run, so the Cloudflare host cannot run locally in a container.
- Outbound `fetch()` from the app is subject to CORS from a StackBlitz origin. A blocked request fails with `SocketError: other side closed`.
- Spawned arguments lose backslashes. Mount a script file and run it instead of `node -e`.

## Inspect

Everything this package does runs in the reader's tab, so there is no server state to list yet. Read `container.status` for the stages and timings of a run. The docs build writes the tutorial snapshots with `createNodeModulesSnapshot()` (`docs/modules/tutorials/snapshots.ts`).

## Test

```sh
pnpm --filter @vite-hub/web-container test           # unit tests in Node
pnpm --filter @vite-hub/web-container test:browser   # boots a real WebContainer in headless Chromium
```

The browser test needs a Playwright Chromium (`pnpm exec playwright-core install chromium`) and network access to StackBlitz. Set `WEB_CONTAINER_TEST_PORT` to change its port (default `4793`).
