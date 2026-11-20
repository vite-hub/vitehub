# @vite-hub/workflow

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/static/v1?label=ViteHub&amp;message=vitehub.dev&amp;color=blue"></a>
  <img alt="TypeScript" src="https://img.shields.io/static/v1?label=TypeScript&amp;message=ready&amp;color=blue">
  <img alt="Vite" src="https://img.shields.io/static/v1?label=Vite&amp;message=discovery&amp;color=blue">
  <img alt="Workflow" src="https://img.shields.io/static/v1?label=Workflow&amp;message=durable+steps&amp;color=blue">
</p>

`@vite-hub/workflow` discovers named long-running work and exposes one provider-neutral API for starting and inspecting runs.

Use a Workflow when the application needs a run id, durable state, retries, cancellation, or resumable work. Use [Queue](https://vitehub.dev/docs/queue) when background delivery is enough and the application does not need to inspect a run.

## Install

```sh
pnpm add @vite-hub/workflow
```

Then install the dependency required by the selected driver:

| Provider             | Additional dependency                                              | Durable state                                                            |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Cloudflare Workflows | None in application code                                           | Cloudflare owns run state. Without the binding, only `vite dev` runs inline; a Worker fails with `WORKFLOW_R0036`. |
| Vercel Workflow      | `@vercel/functions`; add `workflow@5.2.3` and `@workflow/builders@5.0.6` for native durable definitions ([versions](#make-a-vercel-workflow-durable)) | Native definitions survive function restarts; plain handlers run inline. |
| OpenWorkflow         | None. `@vite-hub/workflow` depends on `openworkflow` and `postgres` | Postgres Default Database, else a local SQLite file.                     |

Importing the provider-neutral package root does not load OpenWorkflow types. Worker lifecycle helpers live at `@vite-hub/workflow/openworkflow`.

On Node and Docker, ViteHub selects OpenWorkflow when `driver` is not set, also in `vite dev` with the `node` host. OpenWorkflow reads its storage at runtime. Set `workflow.sqlite.path` or `workflow.postgres.url` to select the storage yourself. An explicit value takes precedence over ambient storage environment variables. Without it, `OPENWORKFLOW_SQLITE_PATH` selects SQLite, then `OPENWORKFLOW_POSTGRES_URL` selects Postgres. Then, when the app has a Postgres Default Database, OpenWorkflow uses its connection URL (`getPostgresConnectionUrl()` from `@vite-hub/database`). A `DATABASE_URL` alone is not used, the same as for Queue and Realtime. If it contains a `postgres://` or `postgresql://` URL and storage would otherwise fall back to SQLite, resolution fails with `WORKFLOW_OPENWORKFLOW_DATABASE_URL_IGNORED`. Before upgrading, set `OPENWORKFLOW_POSTGRES_URL` or `workflow.postgres.url` to that same URL, or add a Postgres Default Database pointing to the existing database. Keep the same schema and namespace to retain queued and sleeping runs. Select `workflow.sqlite.path` or `OPENWORKFLOW_SQLITE_PATH` to choose local storage intentionally. Other `DATABASE_URL` schemes do not trigger the error. `vite dev` keeps runs in the local SQLite file unless `workflow.remote` is `true`, so a dev server never runs the runs of a shared database. A configured environment declaration must resolve to a value; missing configuration rejects before opening a backend. With no storage configuration or storage environment variables, OpenWorkflow uses `.vitehub/data/openworkflow.sqlite.db`, and the server logs at boot that other instances do not see those runs.

The former `workflow.database` option was never connected to Named Databases. It now rejects instead of silently selecting fallback storage. Replace it with `workflow.sqlite.path` or `workflow.postgres.url`.

## Define a workflow

```ts fragment
// server/workflows/onboard-user.ts
import { defineWorkflow } from "@vite-hub/workflow";

export default defineWorkflow<{ email: string }>({
  handler: async ({ payload, id, provider }) => {
    const idempotencyKey = `onboard-user:${payload.email}`;
    const user = await upsertUser(payload.email, { idempotencyKey });
    await sendWelcomeEmail(user.email, { idempotencyKey: `${idempotencyKey}:welcome-email` });

    return { id, provider };
  },
});
```

Both external operations receive keys derived from stable input. Preserve that idempotency when adding side effects so retrying a completed operation does not duplicate it.

ViteHub discovers `server/workflows/<name>.ts`, folder workflows such as `server/workflows/onboard-user/index.ts`, and `src/<name>.workflow.ts`. The file or folder path is the Workflow name. `defineWorkflow()` takes one object and no name. Pass the name to the runtime helpers.

The handler gets one object with `payload`, `id`, `name`, `provider`, `sleep`, and `steps`. Pass the payload type as the type argument of `defineWorkflow()`. ViteHub writes the names and payload types to `.vitehub/workflow.d.ts`, so `startWorkflow("onboard-user", payload)` checks both.

## Call typed steps

A folder Workflow runs its numbered files as steps. `01.create-user.ts` becomes `steps.createUser`:

```ts [server/workflows/onboard-user/index.ts]
// server/workflows/onboard-user/index.ts
import { defineWorkflow } from "@vite-hub/workflow";

export default defineWorkflow<{ email: string }>({
  handler: async ({ payload, steps }) => {
    const user = await steps.createUser(payload);
    return await steps.sendWelcome(user);
  },
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

The Vite Integration writes `.vitehub/workflow.d.ts`. A step name shared by multiple folders accepts only inputs that all those steps accept and can return any of their result types. A call to a step that has no file is a type error. At runtime, only the current folder's steps are available. Include `.vitehub/workflow.d.ts` in your TypeScript project; `vite-hub` includes it through `.vitehub/types.d.ts`.

## Configure the driver

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
  driver: "openworkflow",
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

For a standalone Vite app, install Nitro 3 before adding its server plugin:

```sh
pnpm add -D nitro@^3.0.261103-rc
```

```ts fragment
// vite.config.ts
import { hubWorkflow } from "@vite-hub/workflow/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { workflowConfig } from "./server/workflow-runtime.ts";

export default defineConfig({
  nitro: { serverDir: "./server" },
  plugins: [hubWorkflow(workflowConfig), nitro()],
});
```

`hubWorkflow()` adds Workflow discovery and host output, but no server. Nitro gives the app its server and reads the routes in `server/`. Without `nitro()`, a plain Vite build fails with `Cannot resolve entry module index.html`. `vitehub({ workflow: workflowConfig })` includes Nitro and installs the driver config and registry in the server, so an app that uses it does not need `installWorkflowRuntime()`.

The Vite config, application process, and worker below share one driver config. The runtime installer also registers the same definitions in both processes. Set `driver` explicitly when the deployment target should not decide it. Otherwise ViteHub selects Cloudflare on Cloudflare hosting, OpenWorkflow on Node and Docker, and Vercel on Vercel. Deno requires an explicit driver or OpenWorkflow storage for builds; development and Agent-only Workflows can run inline. Netlify cannot infer a driver.

OpenWorkflow accepts one storage choice: `postgres.url` or `sqlite.path`. Hosted credentials belong in Server Env, not source code.

### Run an OpenWorkflow worker

`startWorkflow()` only enqueues an OpenWorkflow run, and a worker executes it. With `hubWorkflow()` or `vitehub()`, the generated Nitro startup plugin of a Node or Docker server calls `installOpenWorkflow(nitroApp)`. When the registry has discovered Workflow or Agent files, it loads OpenWorkflow from the server bundle and starts one worker. With only inline Workflows, it does not resolve or open OpenWorkflow storage or start a worker. The worker executes 10 runs at once; set `workflow.worker.concurrency` to change it. Each Agent turn uses two runs: the turn and its recovery run. The worker stops when Nitro closes or the process gets `SIGTERM`. Several servers can run a worker on the same Postgres database. Servers that start together set up the OpenWorkflow schema one at a time, so they do not fail with `duplicate key value violates unique constraint`. A server tries a Postgres advisory lock (`pg_try_advisory_xact_lock`) in a short transaction, and waits without a connection when another server holds it. OpenWorkflow does not export its migrations, so they run on their own connection while the lock transaction holds another. The server that gets the lock first checks for that second connection and stops with `WORKFLOW_OPENWORKFLOW_SETUP_CONNECTION_UNAVAILABLE` when it gets none in 10 seconds, then holds the lock until the setup ends. OpenWorkflow claims each run with `FOR UPDATE SKIP LOCKED`, so one worker executes it. When setup or the worker start fails, the server reports the error and tries again, with a delay that grows to 30 seconds, until it works or the server closes. `WORKFLOW_OPENWORKFLOW_DATABASE_URL_MISSING` and `WORKFLOW_OPENWORKFLOW_DATABASE_URL_IGNORED` stop the retries, because only a configuration change fixes it. `WORKFLOW_OPENWORKFLOW_SETUP_CONNECTION_UNAVAILABLE` (no second connection in 10 seconds) is retried, because a full pool frees connections later. `installOpenWorkflow()` resolves to `true` when the worker runs.

Every worker registers the discovered Workflow Definitions of the build registry when it starts, and any worker can claim a run. So OpenWorkflow runs only those definitions. The registry has each discovered Agent Workflow and its invocation recovery Workflow, so Agent turns are durable OpenWorkflow runs. The startup registry also installs the generated Agent State resolver and Capability loaders, so a fresh worker can restore persisted Channel deliveries without loading an Agent route first. A turn of an Agent that is not discovered fails with `WORKFLOW_AGENT_NOT_DISCOVERED`. A definition that code registers later, such as an inline `createWorkflow(name, handler)`, runs inline in the request process, with `metadata.mode` set to `"inline"` and a warning. In `vite dev`, a changed Workflow file replaces the worker; the old backend stays open until the old worker finishes its runs.

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
  const [startError, started] = await startWorkflow("onboard-user", payload);
  if (startError) throw startError;

  const [error, run] = await getWorkflowRun("onboard-user", started.id);
  if (error) throw error;
  return run;
});
```

`startWorkflow()` returns `[error, run]`: a normalized acknowledgement with an id, provider, and status. `getWorkflowRun()`, `cancelWorkflow()`, `resumeWorkflow()`, and the `start`, `getRun`, and `cancel` methods of a handle also return `[error, data]`. A provider failure, an unsupported option, or an invalid `delay` is `error`; its `code` is a `WorkflowResultErrorCode`. A config error, such as an unknown Workflow name, throws. When you pass `{ id }`, that id is the run id on Cloudflare, OpenWorkflow, and inline runs, and a second start with the same id returns the first run. `getWorkflowRun()` returns normalized run and step state, including timestamps, attempts, and results when the provider supplies them. A failed run has `error`: `{ message, name?, code? }`, safe to send as JSON, on every provider. `metadata` keeps provider data and no longer holds the error. Every provider reports the same statuses: a sleeping or waiting run reports `running`, a Cloudflare `terminated` run reports `cancelled`, and a run id that does not exist reports `unknown`.

To set your own id, pass `{ id }`. On Cloudflare, start with a letter, a digit, or `_`, then use only letters, digits, `-`, and `_`, up to 100 characters. `startWorkflow()` returns the error `WORKFLOW_CLOUDFLARE_RUN_ID_INVALID` for another id. Inspection queries the binding because existing instance ids can follow different rules.

The other runtime helpers are:

- `deferWorkflow()` starts a run after the response, through `waitUntil`. It returns nothing and logs a failure. Call `startWorkflow()` when you need the run id.
- `cancelWorkflow()` cancels a Cloudflare run with `instance.terminate()`, a native Vercel run, or a pending or running OpenWorkflow run. A finished run keeps its status, and a missing run reports `unknown`.
- `resumeWorkflow(token, value)` sends `value` to a run that waits on `context.createSignal()`, or resumes a Workflow DevKit hook token on Vercel.
- `createWorkflow()` creates a named handle with `start`, `defer`, `getRun`, and `cancel` methods.

Unsupported provider operations fail with `WORKFLOW_OPERATION_UNSUPPORTED`; ViteHub does not pretend that an inline run was cancelled or resumed.

`hubWorkflow()` contributes the `workflow.start`, `get`, `cancel`, `resume`, `runs-list`, `runs-show`, and `runs-clear` operations. In `vite dev`, the dev Nitro plugin records every inline run in the memory of the dev server: its status, times, result, error, and each step of a folder Workflow. `vitehub workflow runs list` lists the newest runs first, `vitehub workflow runs show <runId>` shows one with its steps, and `vitehub workflow runs clear --yes` removes them all. The history keeps the newest 200 runs until the dev server restarts. It does not include runs that a Cloudflare binding, OpenWorkflow, or a native Vercel Workflow executes. Only the dev Nitro plugin imports the `runtime/dev-runs` module, by file path. It holds the history. The production runtime has only an empty recorder slot, so a build does not include the history code and never records runs. The three commands fail there with `WORKFLOW_RUNS_UNAVAILABLE`.

The `result` of a completed run is the value that the handler returned, stored as JSON. Every provider returns the same plain value, so a `Date` comes back as a string and `undefined` fields are dropped. Return a JSON-safe value, or return a `Response` for binary data or for status and headers. When the handler returns a `Response`, `result` is a `Response`.

Inline runs buffer a returned `Response` body before completion. Each inspection and duplicate start returns a fresh `Response`, so reading or cancelling one result does not consume later results. A body read failure marks the run as failed.

Inline run inspection uses weak references while execution is active. A reachable execution remains inspectable; an abandoned execution with no remaining owner can be garbage-collected and then reports `unknown`. Completed inline runs are retained for five minutes, up to 1,024 entries per runtime. In `vite dev`, `getWorkflowRun()` also reads the dev run history, which keeps the newest 200 runs until the dev server restarts. Completed history does not evict active executions. If either `WeakRef` or `FinalizationRegistry` is unavailable, active inspection uses strong references capped at 1,024 entries. Starting another run evicts the oldest active inspection entry, even if execution is still reachable; it reports `unknown` and completion does not restore it. Use a durable provider when inspection must survive abandonment or a process restart.

## Start a run later

Pass `delay` to start the run later. It accepts a duration such as `"30m"` or `"3 days"`, or a `Date` that the run must not start before. A `Date` in the past starts the run now. `startWorkflow()` returns `RUNTIME_DURATION_INVALID` for an invalid duration, including a bare number, and `WORKFLOW_START_DELAY_INVALID` for an invalid or out-of-range start time. Use a `Date` for a month or a calendar time. `delay` works with `{ id }`.

```ts fragment
const [error, run] = await startWorkflow("send-reminder", { email }, { delay: "3 days", id: `reminder-${userId}` });
```

| Provider | How the delay works | Status during the delay |
| --- | --- | --- |
| OpenWorkflow | The run stays pending in storage until its start time (`availableAt`). | `queued` |
| Cloudflare | The run sleeps with `step.sleepUntil()` before the handler. A waiting instance does not count toward the concurrency limit. | `running` |
| Vercel `native` entry of a folder Workflow | The generated entry calls Workflow DevKit `sleep()` before the first step. | `running` |
| Vercel `native` entry that you wrote | Not supported. `startWorkflow()` returns the error `WORKFLOW_OPERATION_UNSUPPORTED`. | |
| Inline runs (`vite dev`, normal Vercel handlers) | A timer in the process. It is not durable: a restart loses the run. | `queued` |

For a recurring run, call `startWorkflow()` from a [Schedule](https://vitehub.dev/docs/schedule) handler.

## Make a Vercel workflow durable

A plain Vercel definition executes inline and does not survive a function restart. Install `@vercel/functions` as shown in the provider table above for all Vercel definitions. For durable execution, also install the Workflow DevKit packages, keep the same handler, and register a native entry:

```sh
pnpm add --save-exact workflow@5.2.3 @workflow/builders@5.0.6
```

The peer ranges accept any 5.x from these versions. ViteHub tests with 5.2.3 and 5.0.6. Workflow 5.3.0 and later end a run as soon as the workflow function returns, even while a losing `Promise.race` step still runs; see [Upgrade the Vercel Workflow SDK](https://vitehub.dev/docs/workflows/hosts#upgrade-the-vercel-workflow-sdk).

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

export default defineWorkflow<OnboardPayload>({
  handler: async ({ payload }) => {
    const user = await upsertUser(payload.email, { idempotencyKey: `onboard-user:${payload.email}` });
    return { userId: user.id };
  },
  native: durableOnboard,
});
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

`code` and `message` remain available through `error.toJSON()`. Keep `details` JSON-safe and free of secrets; `toJSON()` omits `cause`, which remains available only on the in-memory error. ViteHub's built-in codes are typed as `WorkflowErrorCode` and use code-derived messages and code-specific details. A `ViteHubError` does not change the retry policy.

A step gets 3 retries after the first attempt, 10 seconds apart and then twice as long each time. A step file can export its own policy and a time limit for each attempt:

```ts
export const retries = { limit: 5, delay: "30 seconds", backoff: "exponential" };
export const timeout = "2 minutes";
```

Cloudflare gets both in `step.do()`. OpenWorkflow gets `retries` as its `retryPolicy`, and a generated Vercel step gets `limit` as `maxRetries`. Vercel steps cannot set `delay` or `backoff`, so the build fails with `WORKFLOW_STEP_RETRY_DELAY_UNSUPPORTED`. Outside Cloudflare, ViteHub enforces `timeout` itself: it aborts the `signal` that the step function gets as its second argument and fails the attempt. Code that ignores the signal keeps running. An inline run does not retry. See [Retries and sleeps](https://vitehub.dev/docs/workflows/limits-and-errors#retries-and-sleeps).

Throw `NonRetryableError` when another attempt cannot succeed. The run fails at once on every provider. `getWorkflowRun()` reports the error `message` and `name` in `metadata` for inline and OpenWorkflow runs, Cloudflare keeps the error in its status record in `metadata`, and a Vercel `native` run reports the message on the failed step in `steps`.

```ts fragment
import { NonRetryableError } from "@vite-hub/workflow";

throw new NonRetryableError("The card was declined.", { cause });
```

Cloudflare gets its own `NonRetryableError` from ViteHub. Workflow DevKit reads `fatal: true`, as for its `FatalError`. OpenWorkflow has no such error, so ViteHub ends the step with the error as its result and fails the run outside the step. A replay reads that result and throws the same error. ViteHub finds the error by `isRetryable === false` or by its name, so an error from another bundle also works.

Only a folder Workflow can sleep. Its `index.ts` calls `context.sleep()` between steps, with a duration or a `Date`. A duration is a number of milliseconds or a string such as `"30 seconds"` or `"1 day"`: a number, one space, and a unit (second, minute, hour, day, week, month, or year, with or without a final `s`). A month is 30 days and a year is 365.25 days.

```ts fragment
// server/workflows/remind-user/index.ts, next to 01.send-welcome.ts and 02.send-reminder.ts
export default defineWorkflow<{ email: string, remindAt: string }>({
  handler: async ({ payload, sleep, steps }) => {
    await steps.sendWelcome(payload);
    await sleep("1 day");
    await sleep(new Date(payload.remindAt));
    await steps.sendReminder(payload);
  },
});
```

The sleep is durable on Cloudflare (`step.sleep` and `step.sleepUntil`, at most 365 days) and OpenWorkflow. Inline runs, in `vite dev` and in normal Vercel handlers, wait with a timer. That wait is not durable: a restart loses the run. A Vercel `native` entry uses Workflow DevKit's `sleep()`.

After a sleep, the provider runs `index.ts` again from the start, and completed step files return their stored results. ViteHub names each sleep by call order (`sleep-1`, `sleep-2`), so `index.ts` must call `sleep()` in the same order on each replay. Put each side effect and each value that changes, such as `Date.now()`, in a step file. `getWorkflowRun()` lists a sleep as a step with the name `sleep-1` and the wake time in `sleepUntil` on OpenWorkflow. A sleeping Cloudflare run reports `running` with `metadata.status: "waiting"`.

A single-file Workflow runs as one root step, and a replay after a sleep would run the code before the sleep again. So `context.sleep()` in a single-file Workflow throws `WORKFLOW_ROOT_STEP_SLEEP` on every provider, and the run fails without a retry. A duration that is not in the form above throws `WORKFLOW_SLEEP_DURATION_INVALID`.

A folder Workflow can wait for a value from outside the run, such as a webhook. `context.createSignal<T>()` returns `{ token, wait() }`. Give `token` to the other service, then call `wait()`. `resumeWorkflow(token, value)` sends a JSON value, and `wait()` returns it.

```ts fragment
// server/workflows/summary/index.ts
export default defineWorkflow<{ callId: string }>({
  handler: async ({ createSignal, payload, steps }) => {
    const transcript = createSignal<{ text: string }>();
    await steps.requestTranscript({ callId: payload.callId, token: transcript.token });
    const { text } = await transcript.wait();
    return await steps.summarize({ text });
  },
});

// server/api/webhooks/transcript.post.ts, after the webhook signature check
const [error] = await resumeWorkflow(body.token, { text: body.text });
```

ViteHub makes the token from the Workflow name, the run id, and the call order (`signal-1`, `signal-2`), so a replay gets the same token. The token is not a secret: check the caller before you pass a token from a request. Cloudflare waits with `step.waitForEvent()` for at most 365 days, and `resumeWorkflow()` calls `instance.sendEvent()`. OpenWorkflow waits with `step.waitForSignal()` for one year, then fails the run with `WORKFLOW_SIGNAL_TIMEOUT`. It drops a value that comes before the wait, so `resumeWorkflow()` returns `WORKFLOW_SIGNAL_NOT_WAITING` and the caller retries later. Inline runs wait in memory and keep an early value. Vercel does not support signals yet: `createSignal()` throws `WORKFLOW_SIGNAL_VERCEL_UNSUPPORTED`, and a `native` entry uses `defineHook()` from Workflow DevKit instead. A token of another provider returns `WORKFLOW_SIGNAL_TOKEN_INVALID`, and `wait()` in a single-file Workflow throws `WORKFLOW_ROOT_STEP_SIGNAL`.

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
const welcome = createWorkflow<{ email: string }>("welcome", async ({ payload }) => {
  await sendWelcomeEmail(payload.email)
})
await welcome.start({ email: "ada@example.com" })
// welcome.start() is a type error.
```

This is a breaking type correction. Supply the required payload at each handle call. Named operational functions do not infer a handler from a string, and persisted run results remain unknown.
