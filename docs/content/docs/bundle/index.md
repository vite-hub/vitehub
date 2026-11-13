---
title: Bundle reports
description: Measure the client and the server of a production build, the code that loads at startup, and why each package is in the output.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-package
---

A bundle report describes the JavaScript that a production build wrote. After the build, one command tells you, or your coding agent, how big the client and the server are, how much code loads at startup, and why each package is in the output. `@vite-hub/bundle` writes the report and adds the `vitehub bundle` commands.

Use it to find what makes a Worker slow to start, to check that a change makes the output smaller, and to stop a deploy that the host would reject.

## Turn it on

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

Then build and read the report:

```bash [Terminal]
vite build                         # or nuxt build
vitehub bundle                     # client and server size, startup size, largest groups
vitehub bundle why @libsql/client  # the import chain from the entry to the package
```

The commands read `.vitehub/bundle/` and need no dev server. Development builds are not measured.

## What the report says

- **Client and server.** The bytes and gzip bytes of the JavaScript that the build wrote, and of the files that load at startup.
- **Groups.** Each module counts toward one group: a ViteHub package, a framework package, a dependency, an app folder, or generated code.
- **Why.** The shortest import chain from an entry to a package, a file, or a group.
- **Routes.** In a Nuxt app, what the browser loads on a first visit to each page route.
- **Against.** The change from a saved report, side by side.
- **Checks.** Problems that the report proves, such as a server that is too large for the host.

Vite apps and Nuxt 5 apps with Nitro 3 are supported.

::card-group
  :::card{title="Get started" icon="i-lucide-rocket" to="/docs/bundle/get-started"}
  Measure a build, find why a package is in it, and compare two builds.
  :::

  :::card{title="Read the report" icon="i-lucide-chart-bar" to="/docs/bundle/report"}
  What startup, groups, and routes mean, and how the plugin measures them.
  :::

  :::card{title="Checks" icon="i-lucide-shield-check" to="/docs/bundle/checks"}
  Fail CI when the server is over the host limit.
  :::

  :::card{title="Reference" icon="i-lucide-book-open" to="/docs/bundle/reference"}
  Every command, flag, file, and export.
  :::
::
