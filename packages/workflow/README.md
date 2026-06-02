# @vite-hub/workflow

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
  <img alt="Workflow" src="https://img.shields.io/badge/Workflow-durable%20steps-7c3aed?style=flat-square">
</p>

`@vite-hub/workflow` defines long-running work once and starts it through one `runWorkflow()` API.

## Install

```sh
pnpm add @vite-hub/workflow
```

Add the provider dependency for the workflow provider you configure.

## Minimal API

```ts
// server/workflows/welcome.ts
import { defineWorkflow } from "@vite-hub/workflow"

export default defineWorkflow<{ email: string }>(async ({ id, payload, step }) => {
  const email = await step?.do?.("send-email", {}, async () => {
    return { sentTo: payload.email }
  })

  return { id, email }
})
```

```ts
// server/api/welcome.post.ts
import { getWorkflowRun, runWorkflow } from "@vite-hub/workflow"
import { defineEventHandler, readBody } from "h3"

export default defineEventHandler(async (event) => {
  const run = await runWorkflow("welcome", await readBody<{ email: string }>(event))
  return getWorkflowRun("welcome", run.id)
})
```

```ts
// vite.config.ts
import { hubWorkflow } from "@vite-hub/workflow/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubWorkflow()],
  workflow: { provider: "openworkflow" },
})
```

## Vite Integration

Use `hubWorkflow()` in Vite to discover `server/workflows/<name>.ts`, folder workflows such as `server/workflows/welcome/index.ts` with numbered step files, and `src/<name>.workflow.ts`.

Providers map to [OpenWorkflow](https://openworkflow.dev/docs/overview), [Cloudflare Workflows](https://developers.cloudflare.com/workflows/), or [Vercel Workflow](https://vercel.com/docs/workflow).

Learn more at [vitehub.dev](https://vitehub.dev).
