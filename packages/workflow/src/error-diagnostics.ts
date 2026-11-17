import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: WORKFLOW_B0001, WORKFLOW_R0002, WORKFLOW_R0007, WORKFLOW_R0016, and WORKFLOW_R0031 to WORKFLOW_R0035.
export const workflowErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/workflows/diagnostics",
  codes: {
    WORKFLOW_AGENT_NOT_DISCOVERED: {
      why: ({ name }: { name: string }) => `[vitehub] The Agent Workflow ${JSON.stringify(name)} is not a discovered Agent, so OpenWorkflow workers cannot run its turns.`,
      fix: "Move the Agent to server/agents/, so that the build adds its Workflow to the registry that every OpenWorkflow worker loads. To run it without a Workflow, call runAgent().",
    },
    // Operation errors. The `workflow.*` operations of the CLI, the Console, and Agents throw them with an HTTP status.
    WORKFLOW_DEFINITION_NOT_FOUND: {
      why: ({ available, workflow }: { available?: string, workflow?: string }) => workflow === undefined ? "Workflow definition was not found." : `Unknown Workflow: ${workflow}.${available ?? ""}`,
      fix: "Pass the name of a Workflow Definition, the file name in `server/workflows/` without the extension.",
    },
    WORKFLOW_DISABLED: {
      why: "Workflow is disabled in this runtime.",
      fix: "Enable Workflow with `vitehub({ workflow: true })` or `hubWorkflow()`.",
    },
    WORKFLOW_OPERATION_FAILED: {
      why: "The Workflow operation failed.",
      fix: "Read `error.cause` for the error of the Workflow runtime. Check the Workflow handler and the provider, then retry.",
    },
    WORKFLOW_OPERATION_UNSUPPORTED: {
      why: ({ note, operation, provider }: { note?: string, operation: string, provider: string }) => note === undefined
        ? `workflow ${operation} is not supported by the ${provider} provider for this run.`
        : `workflow ${operation} is not supported by the ${provider} provider. ${note}`,
      fix: "Use an operation that the provider supports, or run the app with a Workflow provider that supports it. The message says what the provider cannot do.",
    },
    WORKFLOW_REGISTRY_MISSING: {
      why: ({ workflow }: { workflow: string }) => `Unknown Workflow: ${workflow}. The runtime has no Workflow registry.`,
      fix: "Restart the dev server. In development the Workflow Vite plugin installs the registry with the Nitro plugin .vitehub/nitro/workflow/dev-plugin.mjs.",
    },
    WORKFLOW_RUNS_UNAVAILABLE: {
      why: "This runtime keeps no Workflow run history. Only `vite dev` records runs.",
      fix: "Run the app with `vite dev`. On a deployment, read one run with `vitehub workflow get <runId> --workflow <name>`, or use the provider dashboard.",
    },
    WORKFLOW_RUN_AMBIGUOUS: {
      why: ({ id, workflows }: { id: string, workflows: string }) => `Runs of ${workflows} have the id ${id}.`,
      fix: "Pass the name of the Workflow with `--workflow <name>`.",
    },
    WORKFLOW_RUN_NOT_FOUND: {
      why: ({ id }: { id: string }) => `No recorded run has the id ${id}.`,
      fix: "Run `vitehub workflow runs list` for the ids. The dev server keeps the newest 200 runs until it restarts or `vitehub workflow runs clear` empties the history.",
    },
    WORKFLOW_RUN_UNKNOWN: {
      why: ({ runId }: { runId: string }) => `Run ${runId} was not started by \`workflow.start\` in this runtime.`,
      fix: "Pass the name of the Workflow with `--workflow <name>`.",
    },

    // Published numbered errors.
    WORKFLOW_C0001: {
      ...dynamicError,
      fix: "Set the `workflow` option that the message names to a non-empty string, or remove it.",
    },
    WORKFLOW_C0002: {
      ...dynamicError,
      fix: "Set the `workflow` option that the message names to a string, or to an env declaration such as `{ kind: \"env-variable\", source: { kind: \"env\", name: \"OPENWORKFLOW_POSTGRES_URL\" } }`.",
    },
    WORKFLOW_C0003: {
      ...dynamicError,
      fix: "Set the `runMigrations` option that the message names to `true` or `false`, or remove it.",
    },
    WORKFLOW_C0004: {
      ...dynamicError,
      fix: "Set `workflow.worker.concurrency` to an integer of 1 or more, or remove it.",
    },
    WORKFLOW_C0005: {
      ...dynamicError,
      fix: "Set `workflow.postgres` to an object, such as `{ url: \"postgres://...\" }`, or remove it.",
    },
    WORKFLOW_C0006: {
      ...dynamicError,
      fix: "Set `workflow.sqlite` to an object, such as `{ path: \".vitehub/data/workflow.sqlite\" }`, or remove it.",
    },
    WORKFLOW_C0007: {
      ...dynamicError,
      fix: "Set `workflow.worker` to an object, such as `{ concurrency: 4 }`, or remove it.",
    },
    WORKFLOW_C0008: {
      ...dynamicError,
      fix: "On Netlify, set `workflow: { driver: \"openworkflow\" }` with `workflow.sqlite.path` or `workflow.postgres.url`, or set `workflow: false`.",
    },
    WORKFLOW_C0009: {
      ...dynamicError,
      fix: "Set `workflow.driver` to `\"cloudflare\"`, `\"openworkflow\"`, or `\"vercel\"`, or remove it to let ViteHub select the driver of the host.",
    },
    WORKFLOW_C0010: {
      ...dynamicError,
      fix: "Rename one of the two step files that the message names, so that each step file of the Workflow folder gives a different step name.",
    },
    WORKFLOW_C0011: {
      ...dynamicError,
      fix: "Rename the step file that the message names so that it has letters after its number prefix, such as `01.create-user.ts`.",
    },
    WORKFLOW_C0012: {
      ...dynamicError,
      fix: "Set only one of `workflow.postgres.url` and `workflow.sqlite.path`, and remove the other.",
    },
    WORKFLOW_C0013: {
      ...dynamicError,
      fix: "Set `workflow` to an object, such as `{ driver: \"openworkflow\" }`, or remove it.",
    },
    WORKFLOW_C0014: {
      ...dynamicError,
      fix: "Pass a function as the second argument of `defineWorkflow()`, such as `defineWorkflow(\"onboard-user\", async (payload, { steps }) => { ... })`.",
    },
    WORKFLOW_C0015: {
      ...dynamicError,
      fix: "Pass the options of `defineWorkflow()` as an object, such as `{ native: durableOnboard }`, or remove the third argument.",
    },
    WORKFLOW_C0016: {
      ...dynamicError,
      fix: "Set `native` in the `defineWorkflow()` options to a function, or remove it.",
    },
    WORKFLOW_C0017: {
      ...dynamicError,
      fix: "Remove `workflow.database`, and set `workflow.sqlite.path` or `workflow.postgres.url`.",
    },
    WORKFLOW_C0018: {
      ...dynamicError,
      fix: "Pass the Workflow name as the first argument of `defineWorkflow()`, such as `defineWorkflow(\"onboard-user\", handler)`.",
    },
    WORKFLOW_C0019: {
      ...dynamicError,
      fix: "Pass the name that the message gives to `defineWorkflow()`, or rename the Workflow file or folder to the name that the definition uses.",
    },
    WORKFLOW_C0020: {
      ...dynamicError,
      fix: "Set `workflow: { driver: \"openworkflow\", sqlite: { path: \".vitehub/data/workflow.sqlite\" } }` or `workflow.postgres.url`, and start the worker with `startOpenWorkflowWorker()`.",
    },
    WORKFLOW_CLOUDFLARE_RUN_ID_INVALID: {
      why: ({ id }: { id: string }) => `[vitehub] Cloudflare does not accept the run id ${JSON.stringify(id)}. A Cloudflare instance id starts with a letter, a digit, or \`_\`, then uses only letters, digits, \`-\`, and \`_\`, up to 100 characters.`,
      fix: "Build the id from allowed characters only, for example `checkout-${orderId}` instead of `checkout:${orderId}`. Hash a long or free-form value first.",
    },
    WORKFLOW_OPENWORKFLOW_DATABASE_URL_IGNORED: {
      why: "DATABASE_URL contains a Postgres URL, but OpenWorkflow no longer selects storage from DATABASE_URL alone. Falling back to a local SQLite file would leave existing Postgres runs behind and stop sharing runs between servers.",
      fix: "Set OPENWORKFLOW_POSTGRES_URL or `workflow.postgres.url` to the same Postgres URL, or add a Postgres Default Database. To choose local storage intentionally, set `workflow.sqlite.path` or OPENWORKFLOW_SQLITE_PATH.",
    },
    WORKFLOW_OPENWORKFLOW_DATABASE_URL_MISSING: {
      why: "OpenWorkflow uses the Postgres Default Database of the app, but that Database has no connection URL outside a request. It connects through PG* environment variables, which OpenWorkflow cannot read.",
      fix: "Set `connection.url` on the Database Definition, or set OPENWORKFLOW_POSTGRES_URL or `workflow.postgres.url`.",
    },
    WORKFLOW_OPENWORKFLOW_SETUP_CONNECTION_UNAVAILABLE: {
      why: "OpenWorkflow sets up its Postgres schema on a second connection while this server holds the setup lock on the first. The database gave no second connection in 10 seconds, so the setup did not start. A pool with one connection, or a pool that other traffic fills, does this. The server tries again later.",
      fix: "Raise the pool size to 2 or more. Or set up the schema once through a direct connection, then set `workflow.postgres.runMigrations: false`.",
    },
    WORKFLOW_OPENWORKFLOW_SETUP_LOCK_TIMEOUT: {
      why: ({ seconds }: { seconds: number }) => `Another server held the OpenWorkflow schema setup lock for ${seconds} seconds. This server did not start the schema setup.`,
      fix: "Check the server that holds the setup lock and let its migration finish. The worker retries automatically. If you start a worker yourself, retry after the lock is released.",
    },
    WORKFLOW_R0001: {
      ...dynamicError,
      fix: "Remove `workflow.binding` and `workflow.name`, which apply only to an app with one Workflow, or keep one Workflow under `server/workflows/`.",
    },
    WORKFLOW_R0003: {
      ...dynamicError,
      fix: "Delete the `.vercel/output` folder and `.vitehub/workflow/vercel-output.json`, then build again, so that ViteHub writes these JSON files again.",
    },
    WORKFLOW_R0004: {
      ...dynamicError,
      fix: "Move the file with `\"use workflow\"` that the message names into the folder of its Workflow under `server/workflows/`.",
    },
    WORKFLOW_R0005: {
      ...dynamicError,
      fix: "Build all native Vercel Workflow source folders in one build, or delete the Workflow DevKit functions that the message lists from `.vercel/output`.",
    },
    WORKFLOW_R0006: {
      ...dynamicError,
      fix: "Install the `workflow` and `@workflow/builders` packages, such as with `pnpm add workflow @workflow/builders`, then build again.",
    },
    WORKFLOW_R0008: {
      ...dynamicError,
      fix: "Rename the Workflow that the message names. Names that start with `vitehub-agent-invocation-recovery-` are for the Workflows that ViteHub generates for Agents.",
    },
    WORKFLOW_R0009: {
      ...dynamicError,
      fix: "Pass `createWorkflow()` a non-empty Workflow name, as `createWorkflow(\"welcome\", handler)` or `createWorkflow({ name, handler })`.",
    },
    WORKFLOW_R0010: {
      ...dynamicError,
      fix: "Pass `createWorkflow()` a handler function, as `createWorkflow(\"welcome\", handler)` or `createWorkflow({ name, handler })`.",
    },
    WORKFLOW_R0011: {
      ...dynamicError,
      fix: "Pass `createWorkflow()` a non-empty Workflow name, as `createWorkflow(\"welcome\", handler)` or `createWorkflow({ name, handler })`.",
    },
    WORKFLOW_R0012: {
      ...dynamicError,
      fix: "Pass `createWorkflow()` a handler function, as `createWorkflow(\"welcome\", handler)` or `createWorkflow({ name, handler })`.",
    },
    WORKFLOW_R0013: {
      ...dynamicError,
      fix: "Pass the options of `createWorkflow(name, options)` as an object, such as `{ handler }`.",
    },
    WORKFLOW_R0014: {
      ...dynamicError,
      fix: "Pass `resumeWorkflow()` the signal token that the waiting step of the run received, as a non-empty string.",
    },
    WORKFLOW_R0015: {
      ...dynamicError,
      fix: "Deploy the Worker with the output of the current build, and keep the file under `server/workflows/` of every Workflow that still has runs on Cloudflare.",
    },
    WORKFLOW_R0017: {
      ...dynamicError,
      fix: "Set `workflow: { driver: \"openworkflow\" }` in `vitehub()`, or pass a `config` with that driver to `createOpenWorkflowWorker()`.",
    },
    WORKFLOW_R0018: {
      ...dynamicError,
      fix: "Set `workflow.sqlite.path` to a local SQLite file, such as `.vitehub/data/workflow.sqlite`. OpenWorkflow cannot use a remote libSQL or HTTP database.",
    },
    WORKFLOW_R0019: {
      ...dynamicError,
      fix: "Set `workflow.sqlite.path` to a local file path or a `file:` URL.",
    },
    WORKFLOW_R0020: {
      ...dynamicError,
      fix: "Set `workflow: { driver: \"openworkflow\" }` in `vitehub()` before you use the OpenWorkflow runtime.",
    },
    WORKFLOW_R0021: {
      ...dynamicError,
      fix: "Send a payload that the schema accepts. Use a schema whose failed `safeParse()` returns an `error`, so that the error names the field.",
    },
    WORKFLOW_R0022: {
      ...dynamicError,
      fix: "Pass `validatePayload()` or `readValidatedPayload()` a function, or a schema with a `safeParse()` or `parse()` method, such as a Zod schema.",
    },
    WORKFLOW_R0023: {
      ...dynamicError,
      fix: "Pass `createWorkflow()` a non-empty Workflow name, as `createWorkflow(\"welcome\", handler)` or `createWorkflow({ name, handler })`.",
    },
    WORKFLOW_R0024: {
      ...dynamicError,
      fix: "Give each inline `createWorkflow()` Workflow a different name.",
    },
    WORKFLOW_R0025: {
      ...dynamicError,
      fix: "Give the inline `createWorkflow()` Workflow and the file under `server/workflows/` different names, or remove one of them.",
    },
    WORKFLOW_R0026: {
      ...dynamicError,
      fix: "Install the `workflow` package version that `@vite-hub/workflow` lists as a peer dependency, then build again. A retry does not help.",
    },
    WORKFLOW_R0027: {
      ...dynamicError,
      fix: "Remove `workflow.database`, and set `workflow.sqlite.path` or `workflow.postgres.url`.",
    },
    WORKFLOW_R0028: {
      ...dynamicError,
      fix: "Set the env variable that `workflow.sqlite.path` reads to a local SQLite file path, or set `workflow.sqlite.path` to a string.",
    },
    WORKFLOW_R0029: {
      ...dynamicError,
      fix: "Set the env variable that `workflow.postgres.url` reads to a Postgres URL, or set `workflow.postgres.url` to a string.",
    },
    WORKFLOW_R0030: {
      ...dynamicError,
      fix: "Keep only one of `workflow.postgres.url` and `workflow.sqlite.path`.",
    },
    WORKFLOW_R0036: {
      why: ({ binding, name }: { binding: string, name: string }) => `[vitehub] The Cloudflare Workflow ${JSON.stringify(name)} needs the binding ${JSON.stringify(binding)}, and the Worker has no binding of that name. ViteHub does not run the Workflow inline outside a development server, because an inline run is not durable.`,
      fix: "Deploy with the Wrangler config that the build writes, or add the Workflow binding to your own Wrangler config. Set `workflow.binding` when the binding has another name.",
    },
    WORKFLOW_B0002: {
      why: ({ root }: { root: string }) => `[vitehub] Cannot identify the owning Workflow build for ${JSON.stringify(root)} because its environment does not uniquely match a resolved configuration.`,
      fix: "Use a separate Workflow plugin instance per build or preserve the resolved build options in each environment config.",
    },
    WORKFLOW_B0003: {
      why: "[vitehub] Agent Workflows need the Agent package, and the project does not resolve `@vite-hub/agent`.",
      fix: "Install `@vite-hub/agent`, or turn the Agent on with `vitehub({ agent: true })`.",
    },
    WORKFLOW_RENAMED_PROVIDER_KEY: {
      why: ({ value }: { value: string }) => `\`workflow.provider\` is ${value}. ViteHub renamed this key to \`driver\`, and it does not read \`provider\`, so Workflow would not use the driver you chose.`,
      fix: ({ value }: { value: string }) => `Set \`workflow: { driver: ${value} }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`,
    },
    WORKFLOW_ROOT_STEP_SLEEP: {
      why: ({ name }: { name: string }) => `[vitehub] The Workflow ${JSON.stringify(name)} called \`context.sleep()\` in its root step. Only a folder Workflow can sleep: move it to \`server/workflows/${name}/index.ts\` and put the work in numbered step files.`,
      fix: "A single-file Workflow runs as one step, so a replay after a sleep would run the code before the sleep again. Move the handler to `server/workflows/<name>/index.ts`, put each side effect in a numbered step file such as `01.charge.ts`, and call `context.sleep()` between the steps.",
    },
    WORKFLOW_SLEEP_DURATION_INVALID: {
      why: ({ name, value }: { name: string, value: string }) => `[vitehub] The Workflow ${JSON.stringify(name)} called \`context.sleep(${value})\`. A sleep takes a duration such as \`'30 seconds'\` or \`'1 day'\`, a number of milliseconds that is 0 or more, or a valid \`Date\`.`,
      fix: "Write the duration as a number, one space, and a unit: second, minute, hour, day, week, month, or year, with or without a final `s`. For example `context.sleep('2 hours')`, `context.sleep(5_000)`, or `context.sleep(new Date(payload.remindAt))`.",
    },
    WORKFLOW_START_DELAY_INVALID: {
      why: ({ delay }: { delay: string }) => `[vitehub] \`startWorkflow()\` does not accept the delay ${JSON.stringify(delay)}. A delay is a number of milliseconds of 0 or more, a duration such as \`"30 minutes"\` or \`"3 days"\`, or a valid \`Date\`.`,
      fix: "Pass `{ delay: 60_000 }`, `{ delay: \"1 hour\" }`, or `{ delay: new Date(\"2026-12-01T09:00:00Z\") }`. The duration units are ms, seconds, minutes, hours, days, and weeks. For a month or a calendar time, pass a `Date`.",
    },
  },
})
