---
title: WebContainer
description: Run a ViteHub app in the reader's browser tab with a StackBlitz WebContainer for docs tutorials and playgrounds.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-app-window
---

`@vite-hub/web-container` runs a ViteHub app inside the reader's browser tab. A WebContainer is a Node.js runtime from [StackBlitz](https://webcontainers.io) that runs in a web page. This package boots one, mounts the app files, runs `npm install` and `npm run dev`, and returns the preview URL. No server of yours runs the app.

It powers the vitehub.dev tutorials and playgrounds. Use it whenever a docs page or demo needs to run a real app without an account or a deploy.

## Install

```bash pm [commands/install]
pnpm add vite-hub @vite-hub/web-container
```

## Entries

| Entry | Runs in | Use it to |
| --- | --- | --- |
| `vite-hub/web-container` | Browser | Boot a container, mount files, run commands, read the preview, and load snapshots. |
| `@vite-hub/web-container/vite` | Vite config | Make pages that boot a container cross-origin isolated. |
| `vite-hub/web-container/snapshot` | Node, at build time | Prebuild `node_modules` locally or in CI so the container skips `npm install`. |
| `vite-hub/web-container/env` | Any | Detect code running inside a WebContainer. |
| `vite-hub/web-container/connect` | Any | Describe the accounts a reader can connect and map them to `env`. |

Every `vite-hub/web-container/*` path re-exports the matching path from `@vite-hub/web-container`. The Vite plugin has only the `@vite-hub/web-container/vite` path.

## Use without ViteHub

A page without `vite-hub` installs `@vite-hub/web-container` on its own and imports every path from it:

```bash pm [commands/install-alone]
pnpm add @vite-hub/web-container
```

```ts [alone/src/playground.ts] fragment
import { bootWebContainer } from "@vite-hub/web-container"
```

## How it works

1. The page sends two headers that make it cross-origin isolated. A WebContainer needs `SharedArrayBuffer`, and the browser gives it only to such pages.
2. `bootWebContainer()` boots the container, mounts your files, and reports each stage so the page can show a checklist.
3. `container.run("install")` and `container.run("dev")` run the app's npm scripts, or a [snapshot](/docs/web-container/snapshots) replaces the install.
4. `container.preview.ready` resolves with the app server URL, ready to show in an `<iframe>`.

Everything runs in the reader's tab, and any secrets you pass to a process stay in that tab. Read `container.status` for boot stages and step timings.

::card-group
  :::card{title="Get started" icon="i-lucide-rocket" to="/docs/web-container/get-started"}
  Make a page cross-origin isolated, boot an app, and show its preview.
  :::

  :::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/web-container/configure"}
  Set production isolation headers, pass secrets, and describe accounts.
  :::

  :::card{title="Skip the install" icon="i-lucide-package" to="/docs/web-container/snapshots"}
  Prebuild `node_modules` once and mount it in every container.
  :::

  :::card{title="API reference" icon="i-lucide-book-open" to="/docs/web-container/reference"}
  Every export, option, and return value.
  :::
::
