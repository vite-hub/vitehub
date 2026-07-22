# @vite-hub/workflow

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
  <img alt="Workflow" src="https://img.shields.io/badge/Workflow-durable%20steps-7c3aed?style=flat-square">
</p>

`@vite-hub/workflow` defines long-running work once and starts it through one `runWorkflow()` API.

Vercel definitions can register a native entry for durable execution. Definitions without one remain source-compatible, but execute inline and do not survive a function restart.

## Install

```sh
pnpm add @vite-hub/workflow
```

Add the provider dependency for the workflow provider you configure.
OpenWorkflow worker lifecycle helpers live at `@vite-hub/workflow/runtime/openworkflow-worker`, so importing the provider-agnostic package root does not require OpenWorkflow's types.

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

For a durable Vercel run, keep the same context-shaped interface and register a native entry containing the Workflow DevKit directive:

```ts
import { defineWorkflow, type WorkflowExecutionContext } from "@vite-hub/workflow"

interface WelcomePayload {
  email: string
}

async function durableWelcome({ payload }: WorkflowExecutionContext<WelcomePayload>) {
  "use workflow"

  return { sentTo: payload.email }
}

async function inlineWelcome({ payload }: WorkflowExecutionContext<WelcomePayload>) {
  return { sentTo: payload.email }
}

export default defineWorkflow(inlineWelcome, { native: durableWelcome })
```

ViteHub transforms the native entry with Workflow DevKit when it generates Vercel provider output.

```ts
// server/api/welcome.post.ts
import { getWorkflowRun, runWorkflow } from "@vite-hub/workflow"
import { defineEventHandler, readBody } from "h3"

export default defineEventHandler(async (event) => {
  const run = await runWorkflow("welcome", await readBody<{ email: string }>(event))
  return getWorkflowRun("welcome", run.id)
})
```

`getWorkflowRun()` normalizes provider run and step state, including timestamps, attempts, and failures. `cancelWorkflow()` cancels a durable run, and `resumeWorkflowSignal()` forwards an opaque signal token created inside the native workflow. Providers that cannot perform an operation fail explicitly instead of simulating it.

Throw `ViteHubError` when app callers need a stable, inspectable Workflow failure instead of parsing log output or provider-specific messages. ViteHub-owned failures use the package's fixed `WorkflowErrorCode` vocabulary.

```ts
import { ViteHubError } from "@vite-hub/runtime"

async function transcribe(recordingId: string) {
  try {
    return await transcribeRecording(recordingId)
  }
  catch (cause) {
    throw new ViteHubError("TRANSCRIPTION_FAILED", "Transcription failed.", {
      cause,
      details: { recordingId },
    })
  }
}
```

`code` and `message` remain available through `error.toJSON()`. Keep `details` JSON-safe and free of secrets; `toJSON()` omits `cause`, which remains available only on the in-memory error. ViteHub's built-in codes are typed as `WorkflowErrorCode` and use code-derived messages and code-specific details. Workflow Step retry behavior belongs in the Step's retry options rather than the error.

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
