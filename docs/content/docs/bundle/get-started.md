---
title: Measure your first build
description: Turn on bundle reports, build the app, read the size of the client and the server, find why a package is in the output, and compare two builds.
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

In this tutorial, you measure the production build of a ViteHub app, find why one package is in the server output, and prove that a change makes the output smaller.

> [!NOTE] Before you start
> You need a Vite or Nitro app with `vitehub()`, or a Nuxt 4.7 (with the `nitro` package) or Nuxt 5 app with `vite-hub/nuxt`. The `vitehub` CLI comes with the `vite-hub` package.

## Turn on the report

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    bundle: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ bundle: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ bundle: true })],
})
```
:::
::

With `bundle: true`, every production build writes a report for each build environment to `.vitehub/bundle/`. A new build removes the reports of older builds.

## Build and read the size

Run a production build and print the report:

```bash [Terminal]
pnpm build
pnpm vitehub bundle
```

The command prints one block for the client and one for the server:

- The JavaScript bytes, the number of files, and the gzip bytes.
- **Startup**: the files that load at startup. On the server, this code runs before the first request.
- **Largest groups**: the ten largest groups, with their total bytes and their startup bytes. A group is a package, an app folder such as `server/api`, or generated code.
- **Largest routes**: in a Nuxt app, the five page routes that load the most code on a first visit.
- **Checks**: the problems that the report proves, or `Checks: no findings.`

Pass `--json` to get the full report as JSON.

## Find why a package is in the output

Pass a package, file, or group name to `why`:

```bash [Terminal]
pnpm vitehub bundle why @libsql/client
```

This prints the shortest import chain from an entry point to that package. Read the chain from the end. The last step before the package is the module that imports it.

In a Nuxt app, pass a URL path to see what a first visit to that page loads:

```bash [Terminal]
pnpm vitehub bundle why /docs/kv
```

The command finds the route that renders the path and lists its startup files, page files, CSS, and the largest modules the page adds.

## Compare two builds

Save the report before you change the code:

```bash [Terminal]
pnpm vitehub bundle --json > .vitehub/bundle-before.json
```

Change the code, build again, and compare:

```bash [Terminal]
pnpm build
pnpm vitehub bundle --against .vitehub/bundle-before.json
```

The command prints the change in bytes, gzip bytes, and startup bytes of each side. It also lists the groups that grew, shrank, were added, or were removed. `--against` also takes a copy of `.vitehub/bundle/`, or the root of another checkout with a build.

## In CI

`vitehub bundle` exits with code 1 when a check finds an error, such as a server that is larger than the host accepts. Run it after the CI build to stop the deploy. See [Checks](/docs/bundle/checks).

::card-group
  :::card{title="Read the report" icon="i-lucide-chart-bar" to="/docs/bundle/report"}
  What each number counts, and what the report cannot see.
  :::

  :::card{title="Reference" icon="i-lucide-book-open" to="/docs/bundle/reference"}
  Every command, flag, and export.
  :::
::
