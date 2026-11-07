---
title: Run a package in a Sandbox
description: Run a package that counts image pixels in Vercel Sandbox and return its JSON result.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You run a small package in a Sandbox and return its result from an API route. A Sandbox is a separate, isolated machine that a provider such as Vercel runs for you. The package gets an image width and height and returns the pixel count. It does not change an image. A simple sum keeps the first result easy to check.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run every command from its root folder.
- a Vercel project with Sandbox access

Each run uses Vercel machines, so Vercel can charge you for it.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add @vite-hub/sandbox typescript @vercel/sandbox nitro h3
pnpm add -D @vite-hub/cli vite
```

- `@vite-hub/sandbox` runs your package in the Sandbox.
- `typescript` lets ViteHub read the Sandbox files when it builds the app.
- `@vercel/sandbox` connects to Vercel Sandbox.
- `nitro` and `h3` serve the API route.
- `@vite-hub/cli` gives you the `vitehub` command. `vite` runs the dev server.

Add the two plugins to `vite.config.ts`. Keep the other plugins that your config already has.

```ts [vite.config.ts]
import { hubSandboxTask } from '@vite-hub/sandbox/task/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubSandboxTask({ provider: 'vercel' }), nitro()],
})
```

`provider: 'vercel'` runs each task in Vercel Sandbox.

In the terminal where you will start the server, set your Vercel values. Replace each placeholder with the value of your Vercel project:

```bash [commands/credentials]
export VERCEL_TOKEN='your-vercel-token'
export VERCEL_TEAM_ID='your-team-id'
export VERCEL_PROJECT_ID='your-project-id'
```

> [!NOTE]
> To use Cloudflare, install `@cloudflare/sandbox` and follow the [Cloudflare host integration](/docs/frameworks-hosts/cloudflare). It creates the Container, Durable Object binding, migration, and Worker exports that Cloudflare needs. A change of `provider` alone does not create them.

::

::tutorial-step{title="Create the package"}
## Create the package

The code that runs in the Sandbox is a separate package project, not another server route. It has its own `package.json` in a folder under `server/sandbox-tasks/`. ViteHub uses the folder name as the task name. Here the name is `image-optimizer`.

Create `server/sandbox-tasks/image-optimizer/package.json`:

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

- `"type": "module"` tells Node.js that the files use `import` and `export`.
- `"exports": "./index.ts"` is the file that the Sandbox runs.
- `"timeout": 30000` stops the run after 30 seconds.

Create `server/sandbox-tasks/image-optimizer/index.ts`. The function multiplies the two numbers and returns JSON data:

```ts [server/sandbox-tasks/image-optimizer/index.ts]
type ImageInput = { width: number, height: number }

export default async function optimize({ width, height }: ImageInput) {
  return {
    pixels: width * height,
    format: 'webp',
  }
}
```

`format: 'webp'` is only sample data. It is not an image. Add an image library after this first run works.

This file does not import ViteHub. If the package needs other dependencies, add them to this `package.json`. ViteHub installs and bundles them with the task.

::

::tutorial-step{title="Call it from a route"}
## Call it from a route

Create `server/api/image-optimizer.post.ts`. It sends the request body to the Sandbox and returns the result:

```ts [server/api/image-optimizer.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runSandboxTask } from '@vite-hub/sandbox/task'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ width: number, height: number }>(event)
  const response = await runSandboxTask('image-optimizer', input)

  if (!response.ok)
    throw createError({ statusCode: response.status, data: await response.json() })

  return await response.json()
})
```

`runSandboxTask()` returns a standard `Response`. Check `response.ok` before you read the body. If the run fails, the route returns the error and not a result.

Start the dev server in the terminal where you set the Vercel values:

```bash [commands/dev]
pnpm vite dev
```

Keep it running. Open a second terminal and send a width and a height to the route:

```bash [commands/request]
curl -X POST http://localhost:5173/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

You see:

```json [output/image-optimizer.json]
{ "pixels": 786432, "format": "webp" }
```

This JSON is the response body, not a file that the Sandbox writes. `786432` is 1024 × 768. This proves that the package ran in the Sandbox and returned its result to your route.

> [!NOTE]
> If the run takes more than 30 seconds, the response has a non-2xx status and a `SANDBOX_TASK_TIMEOUT` error. The provider decides what the Sandbox can reach: the network, the file system, and other processes.

::

::tutorial-step{title="Build and run the server"}
## Build and run the server

Build the app and list the Sandbox tasks that ViteHub found:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind sandbox
```

The list shows `image-optimizer`. This proves that the build found your package.

Stop the dev server. In the terminal where you set the Vercel values, start the built server:

```bash [commands/server]
node .output/server/index.mjs
```

From the second terminal, call the route again. The built server uses port 3000:

```bash [commands/request-built]
curl -X POST http://localhost:3000/api/image-optimizer \
  -H 'content-type: application/json' \
  -d '{"width":1024,"height":768}'
```

You see the same JSON as before. This proves that the built server runs the task too.

::

## Next steps

- [Configure](/docs/sandbox/configure): set more package options, or write a task in one file without a `package.json`.
- [Set timeouts and handle failures](/docs/sandbox/limits-and-errors): handle errors and cleanup.
- [Hosts](/docs/sandbox/hosts): compare Vercel and Cloudflare before you change provider.
