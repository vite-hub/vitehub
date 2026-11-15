import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const workflowErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/workflows/diagnostics",
  codes: {
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
      fix: "On Netlify, set `workflow: { provider: \"openworkflow\" }` with `workflow.sqlite.path` or `workflow.postgres.url`, or set `workflow: false`.",
    },
    WORKFLOW_C0009: {
      ...dynamicError,
      fix: "Set `workflow.provider` to `\"cloudflare\"`, `\"openworkflow\"`, or `\"vercel\"`, or remove it to let ViteHub select the provider of the host.",
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
      fix: "Set `workflow` to an object, such as `{ provider: \"openworkflow\" }`, or remove it.",
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
    WORKFLOW_R0001: dynamicError,
    WORKFLOW_R0002: dynamicError,
    WORKFLOW_R0003: dynamicError,
    WORKFLOW_R0004: dynamicError,
    WORKFLOW_R0005: dynamicError,
    WORKFLOW_R0006: dynamicError,
    WORKFLOW_R0007: dynamicError,
    WORKFLOW_R0008: dynamicError,
    WORKFLOW_R0009: dynamicError,
    WORKFLOW_R0010: dynamicError,
    WORKFLOW_R0011: dynamicError,
    WORKFLOW_R0012: dynamicError,
    WORKFLOW_R0013: dynamicError,
    WORKFLOW_R0014: dynamicError,
    WORKFLOW_R0015: dynamicError,
    WORKFLOW_R0016: dynamicError,
    WORKFLOW_R0017: dynamicError,
    WORKFLOW_R0018: dynamicError,
    WORKFLOW_R0019: dynamicError,
    WORKFLOW_R0020: dynamicError,
    WORKFLOW_R0021: dynamicError,
    WORKFLOW_R0022: dynamicError,
    WORKFLOW_R0023: dynamicError,
    WORKFLOW_R0024: dynamicError,
    WORKFLOW_R0025: dynamicError,
    WORKFLOW_R0026: dynamicError,
    WORKFLOW_R0027: dynamicError,
    WORKFLOW_R0028: dynamicError,
    WORKFLOW_R0029: dynamicError,
    WORKFLOW_R0030: dynamicError,
    WORKFLOW_R0031: dynamicError,
    WORKFLOW_R0032: dynamicError,
    WORKFLOW_R0033: dynamicError,
    WORKFLOW_R0034: dynamicError,
    WORKFLOW_R0035: dynamicError,
    WORKFLOW_R0036: {
      why: ({ binding, name }: { binding: string, name: string }) => `[vitehub] The Cloudflare Workflow ${JSON.stringify(name)} needs the binding ${JSON.stringify(binding)}, and the Worker has no binding of that name. ViteHub does not run the Workflow inline outside a development server, because an inline run is not durable.`,
      fix: "Deploy with the Wrangler config that the build writes, or add the Workflow binding to your own Wrangler config. Set `workflow.binding` when the binding has another name.",
    },
    WORKFLOW_B0001: dynamicError,
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
