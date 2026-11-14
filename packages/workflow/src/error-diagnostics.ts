import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: WORKFLOW_B0001, WORKFLOW_R0002, WORKFLOW_R0007, WORKFLOW_R0016, and WORKFLOW_R0031 to WORKFLOW_R0035.
export const workflowErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/workflows/diagnostics",
  codes: {
    WORKFLOW_C0001: dynamicError,
    WORKFLOW_C0002: dynamicError,
    WORKFLOW_C0003: dynamicError,
    WORKFLOW_C0004: dynamicError,
    WORKFLOW_C0005: dynamicError,
    WORKFLOW_C0006: dynamicError,
    WORKFLOW_C0007: dynamicError,
    WORKFLOW_C0008: dynamicError,
    WORKFLOW_C0009: dynamicError,
    WORKFLOW_C0010: dynamicError,
    WORKFLOW_C0011: dynamicError,
    WORKFLOW_C0012: dynamicError,
    WORKFLOW_C0013: dynamicError,
    WORKFLOW_C0014: dynamicError,
    WORKFLOW_C0015: dynamicError,
    WORKFLOW_C0016: dynamicError,
    WORKFLOW_C0017: dynamicError,
    WORKFLOW_C0018: dynamicError,
    WORKFLOW_C0019: dynamicError,
    WORKFLOW_C0020: {
      ...dynamicError,
      fix: "Set `workflow: { provider: \"openworkflow\", sqlite: { path: \".vitehub/data/workflow.sqlite\" } }` or `workflow.postgres.url`, and start the worker with `startOpenWorkflowWorker()`.",
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
      fix: "Set `workflow: { provider: \"openworkflow\" }` in `vitehub()`, or pass a `config` with that provider to `createOpenWorkflowWorker()`.",
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
      fix: "Set `workflow: { provider: \"openworkflow\" }` in `vitehub()` before you use the OpenWorkflow runtime.",
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
  },
})
