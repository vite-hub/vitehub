# @vite-hub/workflow

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Vite" src="https://comark-ui.onmax.me/badge.svg?label=Vite&amp;value=discovery">
  <img alt="Workflow" src="https://comark-ui.onmax.me/badge.svg?label=Workflow&amp;value=durable+steps">
</p>

`@vite-hub/workflow` discovers named long-running work and exposes one provider-neutral API for starting and inspecting runs.

Use a Workflow when the application needs a run id, durable state, retries, cancellation, or resumable work. Use [Queue](https://vitehub.dev/docs/queue) when background delivery is enough and the application does not need to inspect a run.

## Install

```sh
pnpm add @vite-hub/workflow
```

Then install the dependency required by the selected provider:

| Provider             | Additional dependency                                              | Durable state                                                            |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Cloudflare Workflows | None in application code                                           | Cloudflare owns run state. Without the binding, only `vite dev` runs inline; a Worker fails with `WORKFLOW_R0036`. |
| Vercel Workflow      | `@vercel/functions`; add `workflow` and `@workflow/builders` for native durable definitions | Native definitions survive function restarts; plain handlers run inline. |
| OpenWorkflow         | `openworkflow`; add `postgres` when using Postgres                 | Uses local SQLite by default. Configure durable storage for deployment. |

Importing the provider-neutral package root does not load OpenWorkflow types. Worker lifecycle helpers live at `@vite-hub/workflow/openworkflow`.

Set `workflow.sqlite.path` or `workflow.postgres.url` to select OpenWorkflow storage. An explicit value takes precedence over ambient storage environment variables. A configured environment declaration must resolve to a value; missing configuration rejects before opening a backend. With no storage configuration or storage environment variables, OpenWorkflow uses `.vitehub/data/openworkflow.sqlite.db`.

The former `workflow.database` option was never connected to Named Databases. It now rejects instead of silently selecting fallback storage. Replace it with `workflow.sqlite.path` or `workflow.postgres.url`.

## Define a workflow

```ts fragment
// server/workflows/onboard-user.ts
import { defineWorkflow } from "@vite-hub/workflow";

export default defineWorkflow("onboard-user", async (payload: { email: string }, { id, provider }) => {
  const idempotencyKey = `onboard-user:${payload.email}`;
  const user = await upsertUser(payload.email, { idempotencyKey });
  await sendWelcomeEmail(user.email, { idempotencyKey: `${idempotencyKey}:welcome-email` });

  return { id, provider };
});
```

Both external operations receive keys derived from stable input. Preserve that idempotency when adding side effects so retrying a completed operation does not duplicate it.

ViteHub discovers `server/workflows/<name>.ts`, folder workflows such as `server/workflows/onboard-user/index.ts`, and `src/<name>.workflow.ts`. The file or folder name is the Workflow name. Pass the same name to `defineWorkflow(name, handler)` and to the runtime helpers. A definition that passes another name fails with `WORKFLOW_C0019` when the Workflow loads.

The handler gets `(payload, context)`. Annotate `payload` to type it. `context` has `id`, `name`, `provider`, and `steps`.

## Call typed steps

A folder Workflow runs its numbered files as steps. `01.create-user.ts` becomes `steps.createUser`:

```ts [server/workflows/onboard-user/index.ts]
// server/workflows/onboard-user/index.ts
import { defineWorkflow } from "@vite-hub/workflow";

export default defineWorkflow("onboard-user", async (payload: { email: string }, { steps }) => {
  const user = await steps.createUser(payload);
  return await steps.sendWelcome(user);
});
```

```ts [server/workflows/onboard-user/01.create-user.ts]
// server/workflows/onboard-user/01.create-user.ts
export default async function createUser(input: { email: string }) {
  return { id: `user:${input.email}`, email: input.email };
}
```

```ts [server/workflows/onboard-user/02.send-welcome.ts]
// server/workflows/onboard-user/02.send-welcome.ts
export default async function sendWelcome(user: { id: string, email: string }) {
  return { userId: user.id, welcomeSent: true };
}
```

The Vite Integration writes `.vitehub/workflow.d.ts`. It declares the step files of each folder Workflow, so each step takes the input type of its file and returns its result type. A call to a step that has no file is a type error. Include `.vitehub/workflow.d.ts` in your TypeScript project; `vite-hub` includes it through `.vitehub/types.d.ts`.

## Configure the provider

```ts fragment
// server/workflow-runtime.ts
import type {
  ResolvedWorkflowOptions,
  WorkflowDefinitionRegistry,
} from "@vite-hub/workflow";
import {
  setWorkflowRuntimeConfig,
  setWorkflowRuntimeRegistry,
} from "@vite-hub/workflow/runtime/state";
const postgresUrl = {
  kind: "env-variable",
  source: { kind: "env", name: "OPENWORKFLOW_POSTGRES_URL" },
} as const;

export const workflowConfig = {
  provider: "openworkflow",
  postgres: { url: postgresUrl },
} satisfies ResolvedWorkflowOptions;

const workflowRegistry = {
  "onboard-user": () => import("./workflows/onboard-user.ts"),
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

```ts fragment
// vite.config.ts
import { hubWorkflow } from "@vite-hub/workflow/vite";
import { defineConfig } from "vite";
import { workflowConfig } from "./server/workflow-runtime.ts";

export default defineConfig({
  plugins: [hubWorkflow(workflowConfig)],
});
```

The Vite config, application process, and worker below share one provider config. The runtime installer also registers the same definitions in both processes. Set `provider` explicitly when the deployment target should not decide it. Otherwise ViteHub selects Cloudflare on Cloudflare hosting and Vercel on Vercel hosting. On other hosts, such as Node, Docker, and Deno, `postgres.url` or `sqlite.path` selects OpenWorkflow. Without them, a build fails with `WORKFLOW_C0020` and shows the config to add. Netlify cannot infer a provider. `vite dev`, and the Workflow that only the Agent turns on, run each Workflow inline in the process instead. `vitehub durability list` shows the store that the app uses.

OpenWorkflow accepts one storage choice: `postgres.url` or `sqlite.path`. Hosted credentials belong in Server Env, not source code.

### Run an OpenWorkflow worker

`startWorkflow()` only enqueues an OpenWorkflow run. Start one worker in a long-lived Node or Docker process:

```ts fragment
// worker.ts
import { startOpenWorkflowWorker } from "@vite-hub/workflow/openworkflow";
import { installWorkflowRuntime } from "./server/workflow-runtime.ts";

installWorkflowRuntime();
const worker = await startOpenWorkflowWorker();
```

Keep this process running while it should consume queued runs, and do not start a worker per request. `startOpenWorkflowWorker()` installs `SIGINT` and `SIGTERM` handlers. If the host owns shutdown, await `worker.stop()` from its shutdown hook.

## Start and inspect a run

```ts fragment
// server/api/onboard.post.ts
import { getWorkflowRun, startWorkflow } from "@vite-hub/workflow";
import { defineEventHandler, readBody } from "h3";
import { installWorkflowRuntime } from "../workflow-runtime.ts";

installWorkflowRuntime();

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event);
  const started = await startWorkflow("onboard-user", payload);

  return await getWorkflowRun("onboard-user", started.id);
});
```

`startWorkflow()` returns a normalized acknowledgement with an id, provider, and status. `getWorkflowRun()` returns normalized run and step state, including timestamps, attempts, results, and failures when the provider supplies them. Every provider reports the same statuses: a sleeping or waiting run reports `running`, a Cloudflare `terminated` run reports `cancelled`, and a run id that does not exist reports `unknown`.

The other runtime helpers are:

- `deferWorkflow()` starts a run after the response, through `waitUntil`. It returns nothing and logs a failure. Call `startWorkflow()` when you need the run id.
- `cancelWorkflow()` cancels a native Vercel run or a pending or running OpenWorkflow run.
- `resumeWorkflow()` resumes a registered Vercel Workflow DevKit hook token.
- `createWorkflow()` creates a named handle with `start`, `defer`, `getRun`, and `cancel` methods.

Unsupported provider operations fail with `WORKFLOW_OPERATION_UNSUPPORTED`; ViteHub does not pretend that an inline run was cancelled or resumed.

`hubWorkflow()` contributes the `workflow.start`, `get`, `cancel`, `resume`, `runs-list`, `runs-show`, and `runs-clear` operations. In `vite dev`, the dev Nitro plugin records every inline run in the memory of the dev server: its status, times, result, error, and each step of a folder Workflow. `vitehub workflow runs list` lists the newest runs first, `vitehub workflow runs show <runId>` shows one with its steps, and `vitehub workflow runs clear --yes` removes them all. The history keeps the newest 200 runs until the dev server restarts. It does not include runs that a Cloudflare binding, OpenWorkflow, or a native Vercel Workflow executes. Only the dev Nitro plugin imports the `runtime/dev-runs` module, by file path. It holds the history. The production runtime has only an empty recorder slot, so a build does not include the history code and never records runs. The three commands fail there with `WORKFLOW_RUNS_UNAVAILABLE`.

Inline runs buffer the response body before completion. Each inspection and duplicate start returns a fresh response, so reading or cancelling one result does not consume later results. A body read failure marks the run as failed.

Inline run inspection uses weak references while execution is active. A reachable execution remains inspectable; an abandoned execution with no remaining owner can be garbage-collected and then reports `unknown`. Completed inline runs are retained for five minutes, up to 1,024 entries per runtime. Completed history does not evict active executions. If either `WeakRef` or `FinalizationRegistry` is unavailable, active inspection uses strong references capped at 1,024 entries. Starting another run evicts the oldest active inspection entry, even if execution is still reachable; it reports `unknown` and completion does not restore it. Use a durable provider when inspection must survive abandonment or a process restart.

## Make a Vercel workflow durable

A plain Vercel definition executes inline and does not survive a function restart. Install `@vercel/functions` as shown in the provider table above for all Vercel definitions. For durable execution, also install the Workflow DevKit packages, keep the same handler, and register a native entry:

```sh
pnpm add --save-exact workflow@5.2.3 @workflow/builders@5.0.6
```

```ts fragment
import { defineWorkflow, type WorkflowProviderContext } from "@vite-hub/workflow";

interface OnboardPayload {
  email: string;
}

async function upsertUserStep(email: string) {
  "use step";

  return await upsertUser(email, { idempotencyKey: `onboard-user:${email}` });
}

async function durableOnboard({ payload }: WorkflowProviderContext<OnboardPayload>) {
  "use workflow";

  const user = await upsertUserStep(payload.email);
  return { userId: user.id };
}

async function inlineOnboard(payload: OnboardPayload) {
  const user = await upsertUser(payload.email, { idempotencyKey: `onboard-user:${payload.email}` });
  return { userId: user.id };
}

export default defineWorkflow("onboard-user", inlineOnboard, { native: durableOnboard });
```

ViteHub transforms `native` when it generates Vercel output. Other providers keep using the normal handler. `vite dev` does not transform `native`, so the dev server runs the normal handler inline, also with the Vercel provider. Test the durable entry on a Vercel preview deployment. Vercel calls `native` with a `WorkflowProviderContext`, which has no `steps` runner. Put external side effects in idempotent `use step` functions because a durable step may be retried.

## Handle stable failures

Throw `ViteHubError` when app callers need a stable, inspectable Workflow failure instead of parsing log output or provider-specific messages. ViteHub-owned failures use the package's fixed `WorkflowErrorCode` vocabulary.

```ts fragment
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

- [Workflow guide](https://vitehub.dev/docs/workflows)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [OpenWorkflow](https://openworkflow.dev/docs/overview)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Vercel Workflow](https://vercel.com/docs/workflow)


## Required handle input

A typed Workflow handle requires a payload when its handler requires one. Both `start()` and `defer()` use this rule. A handle with an optional payload or `void` input can still start with no argument. To set start options for a no-input Workflow, pass `undefined` first.

```ts fragment
const welcome = createWorkflow("welcome", async (payload: { email: string }) => {
  await sendWelcomeEmail(payload.email)
})
await welcome.start({ email: "ada@example.com" })
// welcome.start() is a type error.
```

This is a breaking type correction. Supply the required payload at each handle call. Named operational functions do not infer a handler from a string, and persisted run results remain unknown.
