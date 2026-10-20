---
title: Sandbox
navigation.title: Overview
description: Run a small package in an isolated cloud machine on Vercel or Cloudflare, and use its result in your app.
navigation.order: 1
icon: i-lucide-terminal-square
---

::product-hero{tagline="Run code in an isolated cloud machine on Vercel or Cloudflare, and get the result in your route." hosts="Vercel, Cloudflare"}
  :::product-files
  ```ts [server/sandboxes/pixels/index.ts]
  type ImageSize = { width: number, height: number }

  // This runs in its own isolated machine.
  // It is a normal function, with no special imports.
  export default async function count(
    { width, height }: ImageSize,
  ) {
    return { pixels: width * height }
  }
  ```

  ```json [server/sandboxes/pixels/package.json]
  {
    "name": "pixels",
    "private": true,
    "type": "module",
    "exports": "./index.ts",
    "vitehub": {
      "sandbox": { "timeout": 30000 }
    }
  }
  ```

  ```ts [server/api/pixels.post.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { runSandbox } from 'vite-hub/sandbox'

  type ImageSize = { width: number, height: number }

  // Run the pixels package and return its result
  export default defineEventHandler(async (event) => {
    const input = await readBody<ImageSize>(event)
    const response = await runSandbox('pixels', input)

    // A failed or timed-out run has an error status
    if (!response.ok)
      throw new Error(await response.text())
    return response.json()
  })
  ```

  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  // The Vercel preset uses Vercel Sandbox.
  // Use preset 'cloudflare' for Cloudflare Sandbox.
  export default defineConfig({
    plugins: [
      vitehub({ preset: 'vercel', sandbox: true }),
    ],
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="A folder is a Sandbox" icon="i-lucide-folder" to="/docs/sandbox/configure#package-projects"}
  Put a `package.json` and an `index.ts` in a folder under `server/sandboxes`. The folder name is the Sandbox name.
  :::

  :::product-feature-item{title="Plain code and npm packages" icon="i-lucide-package" to="/docs/sandbox/configure#package-entry-point"}
  The entry point is a normal async function. Its dependencies install inside the Sandbox, not in your app.
  :::

  :::product-feature-item{title="Call it from a route" icon="i-lucide-code-2" to="/docs/sandbox/server-api#run-a-sandbox"}
  `runSandbox()` sends the input and returns a standard `Response`. The input type comes from your function.
  :::

  :::product-feature-item{title="Time limits and clear errors" icon="i-lucide-timer" to="/docs/sandbox/limits-and-errors#limits"}
  Set a timeout in `package.json`. A failed or timed-out run returns an error status.
  :::

  :::product-feature-item{title="Vercel or Cloudflare" icon="i-lucide-cloud-cog" to="/docs/sandbox/hosts#providers"}
  Choose the provider in your config. The code in your Sandbox stays the same.
  :::

  :::product-feature-item{title="Know what the code can reach" icon="i-lucide-shield-alert" to="/docs/sandbox/limits-and-errors#production-checks"}
  Sandbox code can use the network and files that the provider allows. Use provider settings to limit them.
  :::
::
