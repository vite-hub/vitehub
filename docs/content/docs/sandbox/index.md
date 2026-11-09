---
title: Sandbox
layout: landing
navigation.title: Overview
description: Run a small package in an isolated cloud machine on Vercel or Cloudflare and use its result in your app.
navigation.order: 1
icon: i-lucide-terminal-square
---

::product-hero{tagline="Run code in an isolated cloud machine on Vercel or Cloudflare, and get the result in your route." hosts="Vercel, Cloudflare"}
  :::code-tree{feature="sandboxTask"}
  ```ts [server/sandbox-tasks/pixels/index.ts]
  type ImageSize = { width: number, height: number }

  // This runs in its own isolated machine.
  // It is a normal function, with no special imports.
  export default async function count(
    { width, height }: ImageSize,
  ) {
    return { pixels: width * height }
  }
  ```

  ```json [server/sandbox-tasks/pixels/package.json]
  {
    "name": "pixels",
    "private": true,
    "type": "module",
    "exports": "./index.ts",
    "vitehub": {
      "sandboxTask": { "timeout": 30000 }
    }
  }
  ```

  ```ts [server/api/pixels.post.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { runSandboxTask } from 'vite-hub/sandbox/task'

  type ImageSize = { width: number, height: number }

  // Run the pixels package and return its result
  export default defineEventHandler(async (event) => {
    const input = await readBody<ImageSize>(event)
    const response = await runSandboxTask('pixels', input)

    // A failed or timed-out run has an error status
    if (!response.ok)
      throw new Error(await response.text())
    return response.json()
  })
  ```

  ::::framework{name="Nuxt"}
  ```ts [nuxt.config.ts]
  // The Vercel host uses Vercel Sandbox.
  // Use host 'cloudflare' for Cloudflare Sandbox.

  export default defineNuxtConfig({
    modules: ['vite-hub/nuxt'],
    vitehub: {
      host: 'vercel',
      // Each run starts a Vercel Sandbox
      sandboxTask: true,
    },
  })
  ```
  ::::
  ::::framework{name="Nitro"}
  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { nitro } from 'nitro/vite'
  import { vitehub } from 'vite-hub'

  // The Vercel host uses Vercel Sandbox.
  // Use host 'cloudflare' for Cloudflare Sandbox.
  export default defineConfig({
    plugins: [
      vitehub({
        host: 'vercel',
        // Each run starts a Vercel Sandbox
        sandboxTask: true,
      }),
      nitro(),
    ],
  })
  ```
  ::::
  ::::framework{name="Vite"}
  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      vitehub({
        host: 'vercel',
        // Each run starts a Vercel Sandbox
        sandboxTask: true,
      }),
    ],
  })
  ```
  ::::
  :::
::

::product-features
  :::product-feature-item{title="A folder is a Sandbox Task" icon="i-lucide-folder" to="/docs/sandbox/configure#package-projects"}
  Put a `package.json` and an `index.ts` in a folder under `server/sandbox-tasks`. The folder name is the task name.
  :::

  :::product-feature-item{title="Plain code and npm packages" icon="i-lucide-package" to="/docs/sandbox/configure#package-entry-point"}
  The entry point is a normal async function. Its dependencies install in the Sandbox, not in your app.
  :::

  :::product-feature-item{title="Call it from a route" icon="i-lucide-code-2" to="/docs/sandbox/server-api#run-a-sandbox-task"}
  `runSandboxTask()` sends the input and returns a `Response`. Your function sets the input type.
  :::

  :::product-feature-item{title="Time limits and clear errors" icon="i-lucide-timer" to="/docs/sandbox/limits-and-errors#limits"}
  Set a timeout in `package.json`. A failed or timed-out run returns an error status.
  :::

  :::product-feature-item{title="Vercel or Cloudflare" icon="i-lucide-cloud-cog" to="/docs/sandbox/hosts#providers"}
  Choose the provider in your config. The task code stays the same.
  :::

  :::product-feature-item{title="Know what the code can reach" icon="i-lucide-shield-alert" to="/docs/sandbox/limits-and-errors#production-checks"}
  Task code can use the network and files that the provider allows. Limit them in provider settings.
  :::
::

::agent-only{skill="sandbox-task" title="Sandbox Tasks"}
Use a Sandbox Task to run a named project inside an isolated Cloudflare or Vercel Sandbox. A Sandbox Task run is an execution boundary, not a general-purpose local shell.

Keep images, mounts, network access, timeouts, and resource bounds explicit. Pass only the files and secrets the run needs.

Prove successful execution, cancellation, timeout, and cleanup on the selected provider. Verify result-size limits only when the provider documents them. Inspect generated bindings and provider output.
::
