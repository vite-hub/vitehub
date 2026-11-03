# @vite-hub/web-container

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fweb-container&icon=npm)](https://npmx.dev/package/@vite-hub/web-container)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fweb-container&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/web-container)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/web-container` runs a ViteHub app in the reader's browser tab, inside a [StackBlitz WebContainer](https://webcontainers.io). Docs tutorials and playgrounds use it to install, start, and preview an app without a server of ours.

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

```ts
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
createServer((req, res) => res.end("Hello from " + process.version)).listen(3000)`,
  },
})

await (await container.run("install")).exit
const dev = await container.run("dev")
dev.output.pipeTo(new WritableStream({ write: chunk => console.log(chunk) }))

const { url } = await container.preview.ready
document.querySelector("iframe")!.src = url
```

- `run("install")` runs `npm install`. `run("dev")` and `run("build")` run the npm scripts of the app. Pass an array, such as `run(["node", "scripts/seed.js"])`, to run any command line.
- A run returns `output` (a stream that you read once), `exit` (the exit code), `text()` (all output after exit), `write(input)`, and `kill()`. Pass `signal` to kill it with an `AbortController`.
- `container.preview.ready` resolves with the first server that becomes ready. It rejects if startup fails or the container is torn down before readiness. The WebContainer chooses the port, so read `url` and `port` from it instead of the port that the app asks for.
- Show the preview in an `<iframe>` on the same page. The preview origin does not answer a `fetch()` from the page.
- `container.fs` is the WebContainer file system API (`readFile`, `writeFile`, `readdir`, `mkdir`, `rm`, `watch`).
- Only one container runs per page. Call `container.teardown()` before you boot another.

### Render a boot checklist

Each status change carries the latest stage and every step so far, with its duration in milliseconds:

```ts
const container = await bootWebContainer({
  files,
  onStatus: ({ stage, steps, error }) => renderChecklist(stage, steps, error),
})
container.on("status", status => renderChecklist(status.stage, status.steps, status.error))
```

The stages are `checking`, `unsupported`, `booting`, `mounting`, `installing`, `starting`, `ready`, and `error`. `installing` starts with `run("install")`. `starting` starts with `run("dev")` and becomes `ready` when the preview server is ready.

To show a notice before the reader clicks run, call `checkWebContainerSupport()`. It checks `crossOriginIsolated` and `SharedArrayBuffer`, not the browser name. `bootWebContainer()` throws `WebContainerUnsupportedError` with the same reason.

### Skip the install with a snapshot

A ViteHub app installs about 680 MB of `node_modules` in 90 to 180 seconds. Install once, export a snapshot, and mount it next time:

```ts
const snapshot = await container.export()
// Later, or in another tab:
const next = await bootWebContainer({ snapshot, files: { "server/routes/edit.ts": editedSource } })
```

`export()` returns a binary snapshot of the working directory. Pass `excludes` (glob patterns) to leave files out. `files` is mounted after the snapshot, so it can replace files from it.

Use one container for each app. One container failed with `RangeError: Offset is outside the bounds of the DataView` after two full ViteHub installs.

## Pass secrets per process

`run()` takes `env` for that process only. Nothing is stored in the container or sent to a ViteHub server:

```ts
await container.run("dev", { env: { OPENAI_API_KEY: key } })
```

## Describe connectable accounts

`@vite-hub/web-container/connect` describes the accounts that a page offers. It runs no OAuth flow yet.

```ts
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
- workerd and Miniflare cannot run, so the Cloudflare preset cannot run locally in a container.
- Outbound `fetch()` from the app is subject to CORS from a StackBlitz origin. A blocked request fails with `SocketError: other side closed`.
- Spawned arguments lose backslashes. Mount a script file and run it instead of `node -e`.

## Inspect

Everything this package does runs in the reader's tab, so there is no server state to list yet. Read `container.status` for the stages and timings of a run. A `vitehub web-container` CLI command comes later, with the snapshot builder for docs tutorials.

## Test

```sh
pnpm --filter @vite-hub/web-container test           # unit tests in Node
pnpm --filter @vite-hub/web-container test:browser   # boots a real WebContainer in headless Chromium
```

The browser test needs a Playwright Chromium (`pnpm exec playwright-core install chromium`) and network access to StackBlitz. Set `WEB_CONTAINER_TEST_PORT` to change its port (default `4793`).
