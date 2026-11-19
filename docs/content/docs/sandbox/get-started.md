---
title: Run a package in a Sandbox
description: Run a package that counts image pixels in Vercel Sandbox and return its JSON result.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Sandbox runs code on a separate, isolated machine, so that code cannot touch your server. You put the code in its own small package, send it input from your app, and get the result back.

In this tutorial, you create a package that takes an image's width and height and returns the pixel count. It does not change an image. A simple calculation makes the first run easy to check. Then you call the package from an API route.

Each Sandbox Task is a separate package project with its own `package.json`, not another server route.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You also need a Vercel project with Sandbox access. The Sandbox runs on Vercel rather than your computer, so each run can cost money.

::tutorial-step{title="Install and choose a provider"}
## Install and choose a provider

Install the Sandbox package and the Vercel Sandbox SDK. Sandbox also uses the TypeScript from Installation to read your package at build time.

```bash pm [commands/install]
pnpm add @vite-hub/sandbox @vercel/sandbox
```

Set `host: 'vercel'` and `sandboxTask: true` in your ViteHub options, keeping your other app options.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'vercel', sandboxTask: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', sandboxTask: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'vercel', sandboxTask: true })],
})
```
::::
:::

- `host: 'vercel'` runs the Sandbox on Vercel. The `node` host has no Sandbox provider, so `sandboxTask: true` fails during config on `node`.

Export your Vercel keys in the terminal where you start the server, using the values from your Vercel project:

```bash [commands/credentials]
export VERCEL_TOKEN='your-vercel-token'
export VERCEL_TEAM_ID='your-team-id'
export VERCEL_PROJECT_ID='your-project-id'
```

To use Cloudflare instead, you need more than `host: 'cloudflare'`. Install `@cloudflare/sandbox` and follow the [Cloudflare host integration](/docs/frameworks-hosts/cloudflare). See [Hosts](/docs/sandbox/hosts) for the steps.

::

::tutorial-step{title="Create the package project"}
## Create the package project

Create the folder `server/sandbox-tasks/image-optimizer`. The folder name is the task name: `image-optimizer`. This folder is the package that runs in the Sandbox.

First, create its `package.json`:

```json [server/sandbox-tasks/image-optimizer/package.json]
{
  "name": "image-optimizer",
  "private": true,
  "type": "module",
  "exports": "./index.ts",
  "vitehub": {
    "sandboxTask": { "timeout": 30000 }
  }
}
```

- `exports` points to the entry file, `index.ts`.
- `timeout: 30000` stops the run after 30 seconds.

Next, create `index.ts` to multiply the width and height:

```ts [server/sandbox-tasks/image-optimizer/index.ts]
type ImageInput = { width: number, height: number }

export default async function optimize({ width, height }: ImageInput) {
  return {
    pixels: width * height,
    format: 'webp',
  }
}
```

- The file is plain TypeScript with no ViteHub imports.
- `format: 'webp'` is only a sample field. This function does not make an image.
- If the package needs dependencies, add them to this `package.json`, not your app's root `package.json`. They are installed and bundled with the task.

::

::tutorial-step{title="Call it from a route"}
## Call it from a route

Create `server/api/image-optimizer.post.ts` to send input to the Sandbox and return its result.

```ts [server/api/image-optimizer.post.ts]
import { defineEventHandler, HTTPError, readBody } from 'h3'
import { runSandboxTask } from 'vite-hub/sandbox/task'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ width: number, height: number }>(event)
  const response = await runSandboxTask('image-optimizer', input)

  if (!response.ok)
    throw new HTTPError({ status: response.status, data: await response.json() })

  return await response.json()
})
```

- `runSandboxTask('image-optimizer', input)` runs the package with your input and returns a standard `Response`.
- If the run fails, `response.ok` is `false`. Always check it before you read the body.

Start the dev server in the terminal where you set your Vercel keys:

```bash [commands/dev]
pnpm dev
```

Open a second terminal and send an image size to the route:

```bash [commands/request]
curl -X POST http://localhost:3000/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

The route returns:

```json [output/image-optimizer.json]
{ "pixels": 786432, "format": "webp" }
```

This JSON is the response body, not a file written inside the Sandbox. If the run takes over 30 seconds, the response has an error status and a `SANDBOX_TASK_TIMEOUT` error. The provider controls what network and files the Sandbox code can reach.

::

::tutorial-step{title="Inspect and continue"}
## Inspect and continue

Build the app and list the Sandbox tasks that ViteHub found:

```bash [commands/inspect]
pnpm build
pnpm vitehub inspect definitions --kind sandbox-task
```

The list shows your package:

```text [output/inspect.txt]
Sandbox Tasks (sandbox-task): 1
  image-optimizer  server/sandbox-tasks/image-optimizer/index.ts  [server-sandbox-tasks]
    Kind: Package entry
```

The `vercel` host writes its output to `.vercel/output` instead of `.output`, so `pnpm start` does not apply. Stop the dev server. In the terminal with your Vercel keys, preview the build locally:

```bash [commands/server]
pnpm vite preview --port 4173
```

Call the route on port 4173 from your second terminal:

```bash [commands/request-built]
curl -X POST http://localhost:4173/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

You get the same JSON response.

::

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/sandbox/configure"}
Set up package projects and review all task options.
:::

:::card{title="Limits and errors" icon="i-lucide-triangle-alert" to="/docs/sandbox/limits-and-errors"}
Configure timeouts and handle failed runs.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/sandbox/hosts"}
Compare Vercel and Cloudflare before switching providers.
:::
::
