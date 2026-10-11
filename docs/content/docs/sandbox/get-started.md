---
title: Run a package in a Sandbox
description: Run a package that counts image pixels in Vercel Sandbox and return its JSON result.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Run a small package in a provider-managed Sandbox and return its result from your app. The package accepts image dimensions and returns their pixel count. It does not transform an image; the calculation keeps this first run easy to check.

You need Node.js 24.15 or newer, pnpm, a Vite application, and a Vercel project with Sandbox access. Run the commands from the app root. Execution uses remote infrastructure and can incur provider charges. A Sandbox is a separate package project, not another server route.

::tutorial-step{title="Install and choose a provider"}
## Install and choose a provider

Install the Vercel Sandbox SDK with the Vite integration and Nitro. Add these plugins to your existing Vite config and keep its other plugins.

```bash [commands/install]
pnpm add @vite-hub/sandbox @vercel/sandbox nitro h3
pnpm add -D @vite-hub/cli vite
```

```ts [vite.config.ts]
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubSandbox({ provider: 'vercel' }), nitro() as never],
})
```

Set your Vercel credentials in the terminal where you will start the server. Replace the placeholders with your project values:

```bash [commands/credentials]
export VERCEL_TOKEN='your-vercel-token'
export VERCEL_TEAM_ID='your-team-id'
export VERCEL_PROJECT_ID='your-project-id'
```

For Cloudflare, install `@cloudflare/sandbox` and use the [Cloudflare host integration](/docs/frameworks-hosts/cloudflare) to generate the required Container, Durable Object binding, migration, and Worker exports. Changing the provider alone does not supply these resources.

::

::tutorial-step{title="Create the package project"}
## Create the package project

Create the package manifest and entrypoint under
`server/sandboxes/image-optimizer`. The folder name becomes the Sandbox
Definition name, while the manifest describes the package that runs in the
isolated environment.

The manifest selects the TypeScript entrypoint and caps the run at 30 seconds. The nested folder is the package that the provider executes.

```json [server/sandboxes/image-optimizer/package.json]
{
  "name": "image-optimizer",
  "private": true,
  "type": "module",
  "exports": "./index.ts",
  "vitehub": {
    "sandbox": { "timeout": 30000 }
  }
}
```

This function multiplies the dimensions and returns JSON-compatible data. The `format` is sample metadata, not an encoded image. Add an image library and real byte handling only after this run works.

```ts [server/sandboxes/image-optimizer/index.ts]
type ImageInput = { width: number, height: number }

export default async function optimize({ width, height }: ImageInput) {
  return {
    pixels: width * height,
    format: 'webp',
  }
}
```

The entrypoint is ordinary ESM code and does not import the Sandbox package.
If the package needs a native dependency, add it to this nested `package.json`;
it is installed and bundled inside the Sandbox project.

::

::tutorial-step{title="Call it from a route"}
## Call it from a route

The route runs the named package and checks the returned HTTP status. It then reads JSON from the native `Response`. A failed run returns an error response rather than this result.

```ts [server/api/image-optimizer.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ width: number, height: number }>(event)
  const response = await runSandbox('image-optimizer', input)

  if (!response.ok)
    throw createError({ statusCode: response.status, data: await response.json() })

  return await response.json()
})
```

Start the Nitro development server with the credentials available in this terminal:

```bash [commands/dev]
pnpm vite dev
```

Keep it running. In another terminal, send the input to the route:

```bash [commands/request]
curl -X POST http://localhost:5173/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

With Vercel Sandbox access configured, you should see:

```json [output/image-optimizer.json]
{ "pixels": 786432, "format": "webp" }
```

This JSON is the response body, not a file that the Sandbox writes. Check
`response.ok` before reading the body. A timeout is a non-2xx response with a
`SANDBOX_TIMEOUT` error. The provider decides the execution boundary and its
available network, filesystem, and process access.

::

::tutorial-step{title="Inspect and continue"}
## Inspect and continue

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind sandbox
```

Stop the development server. In the terminal where you exported the credentials, start the generated Nitro server:

```bash [commands/server]
node .output/server/index.mjs
```

Call the route from another terminal:

```bash [commands/request-built]
curl -X POST http://localhost:3000/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

- Read [Configure](/docs/sandbox/configure) for package projects and free-form Definitions.
- Read [Set timeouts and handle failures](/docs/sandbox/limits-and-errors) for response errors and cleanup.
- Read [Hosts](/docs/sandbox/hosts) before switching providers.
::
