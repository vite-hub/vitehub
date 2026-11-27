---
title: Configure a WebContainer
description: Send the isolation headers, choose the preview port, pass secrets to one process, describe connectable accounts, and detect a WebContainer.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Isolation headers

`vitehub({ webContainer: { routes } })` sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on `routes`:

- In `vite dev` and `vite preview`, from a Vite middleware.
- From the built server, as Nitro route rules. A route rule that the app already has for the same path keeps its other keys and headers.
- In Nuxt, a client route middleware loads a new document when a link crosses into or out of `routes`. Without it, the page keeps the headers of the document it loaded first.

Set the headers only on the routes that boot a container. With `credentialless`, the page can still load cross-origin images and scripts without credentials.

If the page sends `Cross-Origin-Embedder-Policy: require-corp` instead, pass `coep: "require-corp"` to `bootWebContainer()`.

## Choose the preview port

`run()` passes `PORT=3000` to every process. `vite dev` with `vitehub()` and `node .output/server/index.mjs` listen on it. Only the server on that port becomes the preview, not the workers that Nitro starts on random ports first.

- Pass `bootWebContainer({ port })` to use another port for every run.
- Pass `env: { PORT }` to one run to preview that port for that run.
- `container.on("server-ready", ({ url, port }) => …)` reports every server that becomes ready, also for custom commands and restarts. It returns an unsubscribe function.

`run()` also passes `NODE_OPTIONS=--disable-warning=ExperimentalWarning`, because Vite loads the WASI build of Rolldown in a WebContainer and Node warns on each load. Pass your own `NODE_OPTIONS` to replace it.

## Run commands

`run()` takes `"install"`, `"dev"`, `"build"`, or an array:

```ts [src/playground.ts] fragment
await (await container.run("build")).exit
const seed = await container.run(["node", "scripts/seed.js"], { cwd: "." })
console.log(await seed.text())
```

- `"install"` runs `npm install`. `"dev"` and `"build"` run the npm scripts of the app. An array runs that command line.
- Only one `run("dev")` may be active, also while it spawns. Another call rejects until the process exits. Call `kill()` and await `exit` before you start it again.
- `output` is a stream that you read once. It buffers up to 65,536 characters and drops more output until its reader catches up.
- `text()` resolves with the last 65,536 characters of output after the process exits.
- Pass `signal` to kill the process with an `AbortController`.

`container.fs` is the WebContainer file system API: `readFile`, `writeFile`, `readdir`, `mkdir`, `rm`, and `watch`. Only one container runs per page. Call `container.teardown()` before you boot another.

## Pass secrets to one process

`run()` takes `env` for that process only. Nothing is stored in the container or sent to a ViteHub server:

```ts [src/playground.ts] fragment
await container.run("dev", { env: { OPENAI_API_KEY: key } })
```

## Describe connectable accounts

`vite-hub/web-container/connect` describes the accounts that a page offers to the reader. It does not run an OAuth flow: for a provider with `auth: "oauth"`, `ConnectPanel` emits `oauth`, and the page signs the reader in through its own server, which holds the client secret. `connectEnv()` maps the credentials that the reader gives to the `env` variables of each provider:

```ts [src/playground.ts] fragment
import { connectEnv, defineConnect } from "vite-hub/web-container/connect"

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

`isWebContainer()` returns `true` when the code runs inside a WebContainer:

```ts [server/utils/driver.ts]
import { isWebContainer } from "vite-hub/web-container/env"

export const driver = isWebContainer() ? "libsql" : "sqlite"
```

ViteHub packages use it to choose a driver that works in a WebContainer. It reads `process.versions.webcontainer`, so server code that imports it still bundles for a Worker.
