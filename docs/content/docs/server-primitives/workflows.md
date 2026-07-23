---
title: Workflows
description: Start provider-tracked long-running work with run ids, durable state, and optional steps.
navigation.order: 10
icon: i-lucide-workflow
---

Workflows own durable long-running execution. Use them when work needs a Workflow Run, provider-tracked state, retries, resumability, or optional Workflow Steps.

Workflow is not Queue. Queue delivers jobs; Workflow starts and tracks a run.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/workflow
```

### Configure

```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkflow()],
})
```

### Start using it

```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload }) => {
  return createUser(payload.email)
})
```

```ts [server/api/onboard.post.ts]
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async () => {
  return runWorkflow('onboard-user', { email: 'ada@example.com' })
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineWorkflow` from `@vite-hub/workflow` | Declare a Workflow Definition. |
| `runWorkflow`, `deferWorkflow`, `getWorkflowRun` from `@vite-hub/workflow` | Start, defer, or inspect Workflow Runs. |
| `createWorkflow` from `@vite-hub/workflow` | Create an inline Workflow Handle for app-owned code. |
| `normalizeWorkflowOptions` from `@vite-hub/workflow` | Resolve Integration Options to a concrete Workflow Provider. |
| `ViteHubError` from `@vite-hub/runtime` | Throw application-owned Workflow failures with stable codes. |
| `readRequestPayload`, `readValidatedPayload`, `validatePayload` from `@vite-hub/workflow` | Read provider request payloads in custom runtime entrypoints. |
| `hubWorkflow` from `@vite-hub/workflow/vite` | Register Workflow discovery and provider output generation. |

Workflow Provider, Definition, Run, Step, Start Options, and Integration Options types are exported from `@vite-hub/workflow`.

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkflow()],
})
```

The Vite config key is `workflow`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workflow` | `true` or `WorkflowModuleOptions` | disabled | Enables Workflow discovery and provider output through `vitehub()`. |
| `provider` | `WorkflowProvider` | inferred | Selects `cloudflare`, `vercel`, or `openworkflow`. |
| `binding` | `string` | provider default | Provider binding name for generated output. |
| `name` | `string` | discovered workflow name | Provider resource name override. |
| `database` | `string` | none | OpenWorkflow storage through a ViteHub Named Database. |
| `postgres.url` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow Postgres URL. |
| `postgres.schema` | `string` | provider default | OpenWorkflow Postgres schema. |
| `postgres.namespaceId` | `string` | provider default | OpenWorkflow namespace id. |
| `postgres.runMigrations` | `boolean` | provider default | Runs OpenWorkflow storage migrations. |
| `sqlite.path` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow SQLite path. |
| `sqlite.namespaceId` | `string` | provider default | OpenWorkflow SQLite namespace id. |
| `sqlite.runMigrations` | `boolean` | provider default | Runs OpenWorkflow SQLite migrations. |
| `worker.concurrency` | `number` | provider default | OpenWorkflow worker concurrency. |

When no provider is configured, ViteHub selects Cloudflare on Cloudflare hosting and Vercel on other supported hosts. Netlify cannot infer a Workflow Provider, so set `provider` explicitly or disable Workflow there. On Node or Docker hosting, OpenWorkflow is inferred when OpenWorkflow storage is configured through `database`, `postgres.url`, or `sqlite.path`.

## Providers

| Provider | Configure with | Provider output | Nuance |
| --- | --- | --- | --- |
| Cloudflare | `workflow: { provider: 'cloudflare' }` | Cloudflare Workflow class, binding, and runtime entry output. | Runs through Cloudflare Workflow bindings. Use `binding` and `name` when the generated names must match existing infrastructure. |
| Vercel | `workflow: { provider: 'vercel' }` | Vercel workflow runtime output under the build output. | Persists run state through provider runtime support and Vercel-specific workflow names. |
| OpenWorkflow | `workflow: { provider: 'openworkflow', database/postgres/sqlite }` | OpenWorkflow worker/runtime output. | Requires explicit storage. `database`, `postgres.url`, and `sqlite.path` are mutually exclusive storage choices. |

## Define a workflow

Create a Workflow Definition for named long-running work.

```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload }) => {
  const user = await createUser(payload.email)
  await sendWelcomeEmail(user.email)

  return { userId: user.id }
})
```

Use Workflow Steps only when the selected provider and definition need independently retryable or inspectable units.

## Workflow Definition options

`defineWorkflow(handler, options?)` accepts these options. The discovered file name provides the Definition name.

| Option | Type | Description |
| --- | --- | --- |
| `id` | `string` | Static provider id override for the Workflow Definition. |
| `rootStep` | `boolean` | Wraps the handler in a root Workflow Step when the provider supports steps. |

The handler receives a `WorkflowExecutionContext` with `name`, `payload`, `provider`, optional run `id`, and provider-backed `step` or typed `steps` helpers when available.

## Start a run

Use `runWorkflow()` from server code.

```ts [server/api/onboard.post.ts]
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runWorkflow('onboard-user', body, {
    id: `onboard:${body.email}`,
  })
})
```

The run id belongs to Invocation Options. Use a stable id when the provider should dedupe or resume the same logical run.

## Runtime Helpers

| Helper | Description |
| --- | --- |
| `runWorkflow(name, payload?, options?)` | Starts a Workflow Run immediately. |
| `deferWorkflow(name, payload?, options?)` | Starts a run through the deferred provider path when available. |
| `getWorkflowRun(name, id)` | Reads the current run state. |
| `createWorkflow(name, options?)` | Returns a handle with `run`, `defer`, and `getRun`. |

`WorkflowStartOptions` currently accepts `id`.

## Structured errors

Throw `ViteHubError` when app code needs a stable failure contract across Workflow Providers. ViteHub-owned failures use the package's fixed `WorkflowErrorCode` vocabulary.

```ts [server/workflows/transcribe.ts]
import { ViteHubError } from '@vite-hub/runtime'
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ recordingId: string }>(async ({ payload }) => {
  try {
    return await transcribeRecording(payload.recordingId)
  }
  catch (cause) {
    throw new ViteHubError('TRANSCRIPTION_FAILED', 'Transcription failed.', {
      cause,
      details: { recordingId: payload.recordingId },
    })
  }
})
```

Every `ViteHubError` requires a stable `code` and public `message`. Calling `error.toJSON()` returns `name`, `code`, `message`, and JSON-safe `details`; it omits `cause`, which stays on the in-memory error for logging and debugging. ViteHub's built-in codes are typed as `WorkflowErrorCode` with code-derived messages and code-specific details. Configure retries on the Workflow Step; throwing an error does not override the Step's retry policy.

## Workflow Run shape

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Provider or ViteHub Workflow Run id. |
| `provider` | `WorkflowProvider` | Selected provider for the run. |
| `status` | `WorkflowRunStatus` | `queued`, `running`, `completed`, `failed`, or `unknown`. |
| `result` | `TResult` | Completed result when available. |
| `payload` | `TPayload` | Original payload when the provider returns it. |
| `metadata` | `unknown` | Provider metadata. |

## Inspect a run

Use `getWorkflowRun()` when server code needs current run state.

```ts [server/api/workflows/[id].get.ts]
import { getWorkflowRun } from '@vite-hub/workflow'

export default defineEventHandler((event) => {
  return getWorkflowRun('onboard-user', getRouterParam(event, 'id')!)
})
```

## Connect it to Agents

An Agent can start a workflow only when you explicitly expose that behavior through a Capability or server route. Workflow owns durable orchestration; Agent owns model-backed behavior and Agent Invocations.

Use a product-specific Capability when a model should start or inspect a particular Workflow Run.

## Production boundaries

Use Queue when background delivery is enough. Use Workflow when the app must inspect run state, resume work, or coordinate multiple steps over time.

Keep credentials and database URLs in Server Env. Hosted workflow providers may require explicit state storage or deployment setup.

## Next steps

- Use [Queue](/docs/server-primitives/queue) for simple background delivery.
- Trigger recurring work with [Schedule](/docs/server-primitives/schedule).
- Learn shared runtime events in [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces).
