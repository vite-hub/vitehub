---
title: WebContainer
description: Run a ViteHub app in the reader's browser tab with a StackBlitz WebContainer, for docs tutorials and playgrounds.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-app-window
---

`@vite-hub/web-container` runs a ViteHub app in the reader's browser tab. A WebContainer is a Node.js runtime from [StackBlitz](https://webcontainers.io) that runs inside a web page. The package boots one, mounts the app files, runs `npm install` and `npm run dev`, and gives you the URL of the preview. No server of yours runs the app.

The vitehub.dev tutorials and playgrounds use it. Use it when a docs page or a demo must run a real app without an account or a deploy.

## Install

```bash pm [commands/install]
pnpm add @vite-hub/web-container
```

An app that already uses the `vite-hub` package can import the same API from `vite-hub/web-container` and `vite-hub/web-container/connect`.

## Entries

| Entry | Runs in | Use it to |
| --- | --- | --- |
| `@vite-hub/web-container` | Browser | Boot a container, mount files, run commands, read the preview, and load snapshots. |
| `@vite-hub/web-container/vite` | Vite config | Make the pages that boot a container cross-origin isolated. |
| `@vite-hub/web-container/snapshot` | Node, at build time | Install `node_modules` on your machine or in CI, so the container does not install. |
| `@vite-hub/web-container/env` | Any | Detect code that runs inside a WebContainer. |
| `@vite-hub/web-container/connect` | Any | Describe the accounts that a reader can connect, and map them to `env`. |

## How it works

1. The page sends two headers that make it cross-origin isolated. A WebContainer needs `SharedArrayBuffer`, and the browser gives it only to such pages.
2. `bootWebContainer()` boots the container and mounts your files. It reports each stage, so the page can show a checklist.
3. `container.run("install")` and `container.run("dev")` run the npm scripts of the app. A [snapshot](/docs/web-container/snapshots) replaces the install.
4. `container.preview.ready` resolves with the URL of the app server. Show it in an `<iframe>`.

Everything runs in the reader's tab. Secrets that you pass to a process stay in the tab. Read `container.status` for the stages and timings of a boot.

::card-group
  :::card{title="Get started" icon="i-lucide-rocket" to="/docs/web-container/get-started"}
  Make a page cross-origin isolated, boot an app, and show its preview.
  :::

  :::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/web-container/configure"}
  Set the isolation headers in production, pass secrets, and describe accounts.
  :::

  :::card{title="Skip the install" icon="i-lucide-package" to="/docs/web-container/snapshots"}
  Build `node_modules` once and mount it in every container.
  :::

  :::card{title="API reference" icon="i-lucide-book-open" to="/docs/web-container/reference"}
  Every export, option, and return value.
  :::
::
