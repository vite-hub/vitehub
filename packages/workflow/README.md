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
| OpenWorkflow         | None. `@vite-hub/workflow` depends on `openworkflow` and `postgres` | Postgres Default Database, else a local SQLite file.                     |

Importing the provider-neutral package root does not load OpenWorkflow types. Worker lifecycle helpers live at `@vite-hub/workflow/openworkflow`.

On Node and Docker, ViteHub selects OpenWorkflow when `provider` is not set, also in `vite dev` with the `node` host. OpenWorkflow reads its storage at runtime. Set `workflow.sqlite.path` or `workflow.postgres.url` to select the storage yourself. An explicit value takes precedence over ambient storage environment variables. Without it, `OPENWORKFLOW_SQLITE_PATH` selects SQLite, then `OPENWORKFLOW_POSTGRES_URL` selects Postgres. Then, when the app has a Postgres Default Database, OpenWorkflow uses its connection URL (`getPostgresConnectionUrl()` from `@vite-hub/database`). A `DATABASE_URL` alone is not used, the same as for Queue and Realtime. If it contains a `postgres://` or `postgresql://` URL and storage would otherwise fall back to SQLite, resolution fails with `WORKFLOW_R0038`. Before upgrading, set `OPENWORKFLOW_POSTGRES_URL` or `workflow.postgres.url` to that same URL, or add a Postgres Default Database pointing to the existing database. Keep the same schema and namespace to retain queued and sleeping runs. Select `workflow.sqlite.path` or `OPENWORKFLOW_SQLITE_PATH` to choose local storage intentionally. Other `DATABASE_URL` schemes do not trigger the error. `vite dev` keeps runs in the local SQLite file unless `workflow.remote` is `true`, so a dev server never runs the runs of a shared database. A configured environment declaration must resolve to a value; missing configuration rejects before opening a backend. With no storage configuration or storage environment variables, OpenWorkflow uses `.vitehub/data/openworkflow.sqlite.db`, and the server logs at boot that other instances do not see those runs.

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

The Vite config, application process, and worker below share one provider config. The runtime installer also registers the same definitions in both processes. Set `provider` explicitly when the deployment target should not decide it. Otherwise ViteHub selects Cloudflare on Cloudflare hosting, OpenWorkflow on Node and Docker, and Vercel on Vercel. Deno requires an explicit provider or OpenWorkflow storage for builds; development and Agent-only Workflows can run inline. Netlify cannot infer a provider.

OpenWorkflow accepts one storage choice: `postgres.url` or `sqlite.path`. Hosted credentials belong in Server Env, not source code.

### Run an OpenWorkflow worker

`startWorkflow()` only enqueues an OpenWorkflow run, and a worker executes it. With `hubWorkflow()` or `vitehub()`, the generated Nitro startup plugin of a Node or Docker server calls `installOpenWorkflow(nitroApp)`. When the registry has discovered Workflow files, it loads OpenWorkflow from the server bundle and starts one worker. With only Agent or inline Workflows, it does not resolve or open OpenWorkflow storage or start a worker. The worker stops when Nitro closes or the process gets `SIGTERM`. Several servers can run a worker on the same Postgres database. Servers that start together set up the OpenWorkflow schema one at a time, so they do not fail with `duplicate key value violates unique constraint`. A server tries a Postgres advisory lock (`pg_try_advisory_xact_lock`) in a short transaction, and waits without a connection when another server holds it. OpenWorkflow does not export its migrations, so they run on their own connection while the lock transaction holds another. The server that gets the lock first checks for that second connection and stops with `WORKFLOW_R0037` when it gets none in 10 seconds, then holds the lock until the setup ends. OpenWorkflow claims each run with `FOR UPDATE SKIP LOCKED`, so one worker executes it. When setup or the worker start fails, the server reports the error and tries again, with a delay that grows to 30 seconds, until it works or the server closes. `WORKFLOW_R0040` and `WORKFLOW_R0038` stop the retries, because only a configuration change fixes it. `WORKFLOW_R0037` (no second connection in 10 seconds) is retried, because a full pool frees connections later. `installOpenWorkflow()` resolves to `true` when the worker runs.

Every worker registers the discovered Workflow Definitions of the build registry when it starts, and any worker can claim a run. So OpenWorkflow runs only those definitions. A definition that code registers later, such as an inline `createWorkflow(name, handler)` or an Agent Workflow, runs inline in the request process, with `metadata.mode` set to `"inline"` and a warning. In `vite dev`, a changed Workflow file replaces the worker; the old backend stays open until the old worker finishes its runs.

Set `workflow: { worker: false }` to keep the servers from starting a worker. Then start one worker in a separate long-lived process:

```ts fragment
// worker.ts
import { startOpenWorkflowWorker } from "@vite-hub/workflow/openworkflow";
import { installWorkflowRuntime } from "./server/workflow-runtime.ts";

installWorkflowRuntime();
const worker = await startOpenWorkflowWorker();
```

Keep this process running while it should consume queued runs, and do not start a worker per request. A separate worker executes the discovered definitions that it loads from the same registry. `startOpenWorkflowWorker()` installs `SIGINT` and `SIGTERM` handlers. If the host owns shutdown, await `worker.stop()` from its shutdown hook.

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

`startWorkflow()` returns a normalized acknowledgement with an id, provider, and status. `getWorkflowRun()` returns normalized run and step state, including timestamps, attempts, results, and failures when the provider supplies them.

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

ViteHub transforms `native` when it generates Vercel output. Other providers keep using the normal handler. Vercel calls `native` with a `WorkflowProviderContext`, which has no `steps` runner. Put external side effects in idempotent `use step` functions because a durable step may be retried.

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
