# @vite-hub/workflow

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
  <img alt="Workflow" src="https://img.shields.io/badge/Workflow-durable%20steps-7c3aed?style=flat-square">
</p>

`@vite-hub/workflow` discovers named long-running work and exposes one provider-neutral API for starting and inspecting runs.

Use a Workflow when the application needs a run id, durable state, retries, cancellation, or resumable work. Use [Queue](https://vitehub.dev/docs/server-primitives/queue) when background delivery is enough and the application does not need to inspect a run.

## Install

```sh
pnpm add @vite-hub/workflow
```

Then install the dependency required by the selected provider:

| Provider             | Additional dependency                                              | Durable state                                                            |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Cloudflare Workflows | None in application code                                           | Cloudflare owns run state.                                               |
| Vercel Workflow      | `workflow` and `@workflow/builders` for native durable definitions | Native definitions survive function restarts; plain handlers run inline. |
| OpenWorkflow         | `openworkflow`                                                     | Requires explicit SQLite or Postgres storage.                            |

Importing the provider-neutral package root does not load OpenWorkflow types. Worker lifecycle helpers live at `@vite-hub/workflow/runtime/openworkflow-worker`.

## Define a workflow

```ts
// server/workflows/onboard-user.ts
import { defineWorkflow } from "@vite-hub/workflow";

export default defineWorkflow<{ email: string }>(async ({ id, payload, provider }) => {
  const idempotencyKey = `onboard-user:${payload.email}`;
  const user = await upsertUser(payload.email, { idempotencyKey });
  await sendWelcomeEmail(user.email, { idempotencyKey: `${idempotencyKey}:welcome-email` });

  return { id, provider };
});
```

Both external operations receive keys derived from stable input. Preserve that idempotency when adding side effects so retrying a completed operation does not duplicate it.

ViteHub discovers `server/workflows/<name>.ts`, folder workflows such as `server/workflows/onboard-user/index.ts`, and `src/<name>.workflow.ts`. The file name becomes the name passed to runtime helpers.

## Configure the provider

```ts
// server/workflow-runtime.ts
import type {
  ResolvedWorkflowOptions,
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
} from "@vite-hub/workflow";
import {
  setWorkflowRuntimeConfig,
  setWorkflowRuntimeRegistry,
} from "@vite-hub/workflow/runtime/state";
import onboardUser from "./workflows/onboard-user.ts";

const postgresUrl = {
  kind: "env-variable",
  source: { kind: "env", name: "OPENWORKFLOW_POSTGRES_URL" },
} as const;

export const workflowConfig = {
  provider: "openworkflow",
  postgres: { url: postgresUrl },
} satisfies ResolvedWorkflowOptions;

const workflowRegistry = {
  "onboard-user": async () => ({ default: onboardUser as WorkflowDefinition }),
} satisfies WorkflowDefinitionRegistry;

export function installWorkflowRuntime() {
  const url = process.env.OPENWORKFLOW_POSTGRES_URL;
  if (!url) throw new Error("OPENWORKFLOW_POSTGRES_URL is required");

  setWorkflowRuntimeConfig({
    ...workflowConfig,
    postgres: { ...workflowConfig.postgres, url },
  });
  setWorkflowRuntimeRegistry(workflowRegistry);
}
```

```ts
// vite.config.ts
import { hubWorkflow } from "@vite-hub/workflow/vite";
import { defineConfig } from "vite";
import { workflowConfig } from "./server/workflow-runtime.ts";

export default defineConfig({
  plugins: [hubWorkflow()],
  workflow: workflowConfig,
});
```

The Vite config, application process, and worker below share one provider config. The runtime installer also registers the same definitions in both processes. Set `provider` explicitly when the deployment target should not decide it. Otherwise ViteHub selects Cloudflare on Cloudflare hosting and Vercel on other supported hosts. Node and Docker select OpenWorkflow when its storage is configured. Netlify cannot infer a provider.

OpenWorkflow accepts one storage choice: `postgres.url` or `sqlite.path`. Hosted credentials belong in Server Env, not source code.

### Run an OpenWorkflow worker

`runWorkflow()` only enqueues an OpenWorkflow run. Start one worker in a long-lived Node or Docker process:

```ts
// worker.ts
import { startOpenWorkflowWorker } from "@vite-hub/workflow/runtime/openworkflow-worker";
import { installWorkflowRuntime } from "./server/workflow-runtime.ts";

installWorkflowRuntime();
const worker = await startOpenWorkflowWorker();
```

Keep this process running while it should consume queued runs, and do not start a worker per request. `startOpenWorkflowWorker()` installs `SIGINT` and `SIGTERM` handlers. If the host owns shutdown, await `worker.stop()` from its shutdown hook.

## Start and inspect a run

```ts
// server/api/onboard.post.ts
import { getWorkflowRun, runWorkflow } from "@vite-hub/workflow";
import { defineEventHandler, readBody } from "h3";
import { installWorkflowRuntime } from "../workflow-runtime.ts";

installWorkflowRuntime();

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event);
  const started = await runWorkflow("onboard-user", payload);

  return await getWorkflowRun("onboard-user", started.id);
});
```

`runWorkflow()` returns a normalized acknowledgement with an id, provider, and status. `getWorkflowRun()` returns normalized run and step state, including timestamps, attempts, results, and failures when the provider supplies them.

The other runtime helpers are:

- `deferWorkflow()` starts through the deferred provider path when available.
- `cancelWorkflow()` cancels a native Vercel run.
- `resumeWorkflowSignal()` resumes a registered Vercel Workflow DevKit hook token.
- `createWorkflow()` creates a named handle with `run`, `defer`, `getRun`, and `cancel` methods.

Unsupported provider operations fail with `WORKFLOW_OPERATION_UNSUPPORTED`; ViteHub does not pretend that an inline run was cancelled or resumed.

## Make a Vercel workflow durable

A plain Vercel definition executes inline and does not survive a function restart. For durable execution, keep the same context-shaped handler and register a native Workflow DevKit entry:

```sh
pnpm add workflow @workflow/builders
```

```ts
import { defineWorkflow, type WorkflowExecutionContext } from "@vite-hub/workflow";

interface OnboardPayload {
  email: string;
}

async function createUserStep(email: string) {
  "use step";

  return await createUser(email);
}

async function durableOnboard({ payload }: WorkflowExecutionContext<OnboardPayload>) {
  "use workflow";

  const user = await createUserStep(payload.email);
  return { userId: user.id };
}

async function inlineOnboard({ payload }: WorkflowExecutionContext<OnboardPayload>) {
  const user = await createUser(payload.email);
  return { userId: user.id };
}

export default defineWorkflow(inlineOnboard, { native: durableOnboard });
```

ViteHub transforms `native` when it generates Vercel output. Other providers keep using the normal handler. Put external side effects in idempotent `use step` functions because a durable step may be retried.

## Handle stable failures

Throw `ViteHubError` when app callers need a stable, inspectable Workflow failure instead of parsing log output or provider-specific messages. ViteHub-owned failures use the package's fixed `WorkflowErrorCode` vocabulary.

```ts
import { ViteHubError } from "@vite-hub/runtime";

async function transcribe(recordingId: string) {
  try {
    return await transcribeRecording(recordingId);
  } catch (cause) {
    throw new ViteHubError("TRANSCRIPTION_FAILED", "Transcription failed.", {
      cause,
      details: { recordingId },
    });
  }
}
```

`code` and `message` remain available through `error.toJSON()`. Keep `details` JSON-safe and free of secrets; `toJSON()` omits `cause`, which remains available only on the in-memory error. ViteHub's built-in codes are typed as `WorkflowErrorCode` and use code-derived messages and code-specific details. Workflow Step retry behavior belongs in the Step's retry options rather than the error.

## Production checklist

- Confirm that the selected provider is durable enough for the work; inline Vercel handlers are not durable.
- Make side-effecting steps idempotent so retries do not duplicate work.
- Keep provider credentials and database URLs in Server Env.
- Configure durable OpenWorkflow storage and run its migrations before serving traffic.
- Verify start, inspection, failure, retry, cancellation, timeout, and restart behavior on the deployment host.

## Documentation

- [Workflow guide](https://vitehub.dev/docs/server-primitives/workflows)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [OpenWorkflow](https://openworkflow.dev/docs/overview)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Vercel Workflow](https://vercel.com/docs/workflow)
