---
title: Run an app in the browser
description: Make a Vite page cross-origin isolated, boot a small Node app in a WebContainer, and show its preview in an iframe.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

In this tutorial, you add a playground page to a Vite app. The page boots a WebContainer, starts a small Node server in it, and shows the response in an `<iframe>`.

> [!NOTE] Before you start
> You need a Vite app and a browser that supports cross-origin isolation and `SharedArrayBuffer`. You need no StackBlitz account.

## Install the package

```bash pm [commands/install]
pnpm add vite-hub @vite-hub/web-container
```

## Make the page cross-origin isolated

A WebContainer needs `SharedArrayBuffer`. The browser gives it only to a page that sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. Send these headers only on the routes that boot a container, so cross-origin embeds like videos keep working on other pages.

Add `hubWebContainer()` to `vite.config.ts`:

```ts [vite.config.ts]
import { defineConfig } from "vite"
import { hubWebContainer } from "@vite-hub/web-container/vite"

export default defineConfig({
  plugins: [hubWebContainer({ routes: ["/playground/**"] })],
})
```

- The plugin sets the headers in `vite dev` and `vite preview`.
- `/playground` matches that path only. `/playground/**` matches it and every path below it.

Production needs the same headers. [Configure](/docs/web-container/configure#set-the-headers-in-production) shows the Nitro route rules.

## Boot the app

Create the playground page script to mount two files, install dependencies, and start the `dev` script:

```ts [src/playground.ts]
import { bootWebContainer } from "vite-hub/web-container"

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

- `run("install")` runs `npm install`, and `run("dev")` runs the app's `dev` script.
- `run()` passes `PORT=3000` to every process. The server on that port becomes the preview.
- `container.preview.ready` resolves with the preview `url`. Read the URL from it because the preview origin is not `localhost`.
- Render the preview in an `<iframe>` on the same page. The preview origin does not answer a `fetch()` from the page.

Open the page. The iframe shows `Hello from` and the WebContainer's Node version.

## Show a boot checklist

Booting takes a few seconds, and `npm install` can take minutes. Pass `onStatus` to show progress across each stage:

```ts [src/playground.ts] fragment
const container = await bootWebContainer({
  files,
  onStatus: ({ stage, steps, error }) => renderChecklist(stage, steps, error),
})
```

The stages are `checking`, `unsupported`, `booting`, `mounting`, `installing`, `starting`, `ready`, and `error`. Each step has its duration in milliseconds.

To show a notice before the reader starts the app, call `checkWebContainerSupport()`. It checks `crossOriginIsolated` and `SharedArrayBuffer` rather than the browser name. `bootWebContainer()` throws `WEB_CONTAINER_UNSUPPORTED` with the same reason.

## In production

The container runs in each reader's tab, so your host only serves the page and static assets. Send the isolation headers on playground routes, and provide a prebuilt [snapshot](/docs/web-container/snapshots) of `node_modules` so containers skip `npm install`.

::card-group
  :::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/web-container/configure"}
  Set production headers, pass secrets to a process, and describe accounts.
  :::

  :::card{title="Skip the install" icon="i-lucide-package" to="/docs/web-container/snapshots"}
  Prebuild `node_modules` locally or in CI and mount it.
  :::
::
