import { defineErrors } from "@vite-hub/runtime"

import type { QueueDriver } from "./types.ts"

export type QueueProviderOperation = "create-client" | "send" | "send-batch"

// Keep published codes stable. Each code has a heading on the docs page.
export const queueErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/queue/diagnostics",
  codes: {
    // Runtime errors. `send()`, `sendBatch()`, and `sendQueue()` return them as `[error, undefined]`.
    QUEUE_PROVIDER_FAILED: {
      why: ({ operation, provider }: { operation: QueueProviderOperation, provider: QueueDriver }) => `The ${provider} queue provider failed during ${operation}.`,
      fix: "Read `error.cause` for the provider error. Retry when the provider is available again. Pass `idempotencyKey` on Vercel so that a retry does not enqueue the job two times.",
    },
    QUEUE_PROVIDER_INVALID_RESPONSE: {
      why: "The Vercel queue provider accepted the job, but returned an invalid `messageId`.",
      fix: "Do not send the job again without an `idempotencyKey`, because the provider can have it. Check the installed `@vercel/queue` version.",
    },
    QUEUE_UNSUPPORTED_OPTION: {
      why: ({ options, provider }: { options: string, provider: QueueDriver }) => `The ${provider} queue provider does not support the enqueue option ${options}.`,
      fix: ({ options }: { options: string, provider: QueueDriver }) => options.includes("`id`")
        ? "Remove `id`. ViteHub generates the message ID. To deduplicate sends, pass `idempotencyKey` on a provider that supports it."
        : "Remove the option for this provider. The enqueue options table on the Queue Server API page shows which provider supports each option.",
    },

    // Provider cause errors. They are the `cause` of `QUEUE_PROVIDER_FAILED`, as the provider error is in production.
    QUEUE_LOCAL_LIMIT_EXCEEDED: {
      why: ({ limit, max, min, provider, value }: { limit: "batch-bytes" | "batch-empty" | "batch-jobs" | "delay" | "delay-max" | "payload" | "retention", max?: number, min?: number, provider: string, value: number | string }) => ({
        "batch-bytes": `${provider} accepts up to ${max} bytes in one \`sendBatch()\`, got ${value} bytes of JSON.`,
        "batch-empty": "Vercel requires at least one job in a `sendBatch()`.",
        "batch-jobs": `${provider} accepts up to ${max} jobs in one \`sendBatch()\`, got ${value}.`,
        "delay": `\`delaySeconds\` must be a number of seconds from 0, got ${value}.`,
        "delay-max": `${provider} accepts \`delaySeconds\` up to ${max}, got ${value}.`,
        "payload": `${provider} accepts a payload of up to ${max} bytes, got ${value} bytes of JSON.`,
        "retention": `${provider} accepts \`retentionSeconds\` from ${min} to ${max}, got ${value}.`,
      })[limit],
      fix: "Change the job as the message says: `delaySeconds`, `retentionSeconds`, the payload size, or the number or size of the jobs in one `sendBatch()`. The local provider applies the limits of the production provider, so the same job fails there too.",
    },
    QUEUE_VERCEL_BATCH_REJECTED: {
      why: ({ failed, total }: { failed: number, total: number }) => `@vercel/queue did not accept ${failed} of ${total} batch messages.`,
      fix: "Read `results` on this error for the result of each job. Send the failed jobs again with the same `idempotencyKey`, so that Vercel does not enqueue an accepted job two times.",
    },
    QUEUE_VERCEL_SEND_BATCH_UNAVAILABLE: {
      why: "The Vercel queue client has no `sendBatch()`. Install `@vercel/queue` 0.10 or later.",
      fix: "Install `@vercel/queue` 0.10 or later, for example with `pnpm add @vercel/queue@latest`. Or pass a `client` that has `sendBatch()`.",
    },

    // Operation errors. The `queue.*` operations of the CLI, the Console, and Agents throw them. The Queue operations give each code an HTTP status.
    QUEUE_DEFINITION_NAME_INVALID: {
      why: "The queue name is not a valid Queue Definition name.",
      fix: "Pass the name of a Queue Definition. `vitehub queue list` shows them.",
    },
    QUEUE_JOBS_UNAVAILABLE: {
      why: ({ driver }: { driver: string }) => `The ${driver} queue driver does not let the app read its jobs. Only the local and postgres drivers store jobs that ViteHub can list.`,
      fix: "Run the app with `vite dev`, which runs every job in the dev server, or on a Node server with the local or postgres driver. Read hosted jobs in the Cloudflare or Vercel dashboard.",
    },
    QUEUE_JOB_DUPLICATE: {
      why: "A newer pending or running job has the idempotency key of this dead job, so the dead job cannot run again.",
      fix: "Wait for the newer job to end, or remove the dead job with `vitehub queue jobs clear --state dead`.",
    },
    QUEUE_JOB_NOT_FOUND: {
      why: "No stored job has this message ID. The local and postgres drivers delete a job when its handler succeeds.",
      fix: "Run `vitehub queue jobs list` for the IDs of the pending, running, and dead jobs.",
    },
    QUEUE_JOB_RUNNING: {
      why: "The job is running now.",
      fix: "Wait for the attempt to end, then run `vitehub queue jobs show` for its state.",
    },

    // Config errors. An operation throws them when it starts, because the code or the deployment must change.
    QUEUE_BINDING_NOT_FOUND: {
      why: ({ binding }: { binding?: string }) => binding
        ? `The Cloudflare queue binding "${binding}" is not in the Worker env.`
        : "The Cloudflare queue client has no binding.",
      fix: "Run the Worker that `vite build` writes, with `wrangler dev` or a deployment, so its configuration has the generated binding. A custom Worker configuration must keep that binding. `vite dev` runs Queue jobs in the dev server and needs no binding.",
    },
    QUEUE_DEFINITION_LOAD_FAILED: {
      why: ({ queue }: { queue?: string }) => queue ? `The Queue Definition "${queue}" failed to load.` : "A Queue Definition failed to load.",
      fix: "Read `error.cause` for the import error, and fix the Queue Definition module.",
    },
    QUEUE_DEFINITION_NOT_FOUND: {
      why: ({ queue }: { queue?: string }) => queue ? `No Queue Definition has the name "${queue}".` : "No Queue Definition has the requested name.",
      fix: "Add `server/queues/<name>.ts` with a default `defineQueue()` export, and build again with Queue enabled. The generated server output loads the Queue Definitions, so a script that runs outside of it, or an app built without Queue, finds none.",
    },
    QUEUE_DISABLED: {
      why: "Queue is disabled in this runtime.",
      fix: "In `vitehub()`, set `queue.driver` to the driver of the host, or remove `driver`. With `@vite-hub/queue` alone, do not pass `false` to `hubQueue()`, and set a `driver` that matches the host.",
    },
    QUEUE_DRIVER_MISMATCH: {
      why: ({ driver, expected }: { driver: QueueDriver, expected: QueueDriver }) => `The ${expected} Queue runtime received the ${driver} driver.`,
      fix: "Set `queue.driver` to the driver of the deployment preset, and build again.",
    },
    QUEUE_INVALID_BINDING: {
      why: "The Cloudflare queue binding does not have `send()` and `sendBatch()`.",
      fix: "Pass a Cloudflare Queue producer binding, for example `env.WELCOME_QUEUE`.",
    },
    QUEUE_MISSING_REGION: {
      why: "The installed `@vercel/queue` needs a region, and ViteHub cannot find one.",
      fix: "Set `queue.region` in the Vite config, or set the `QUEUE_REGION` environment variable.",
    },
    QUEUE_MISSING_QUEUE: {
      why: "A direct local queue client needs a `queue` name.",
      fix: "Pass the name of a Queue Definition as `queue` to `createQueueClient()`, or use `useQueue()`.",
    },
    QUEUE_LOCAL_MODE_MISMATCH: {
      why: "The local Queue directory already has an engine with a different development error disclosure mode.",
      fix: "Use `useQueue()` in the generated server runtime, or give the direct client a separate directory.",
    },
    QUEUE_MISSING_TOPIC: {
      why: "A direct Vercel queue client needs a `topic`.",
      fix: "Pass `topic` to `createQueueClient()`, or use `useQueue()` for a discovered Queue Definition.",
    },
    QUEUE_POSTGRES_CLOSING: {
      why: "The Postgres Queue runtime is shutting down and cannot accept more jobs or connections.",
      fix: "Send jobs before server shutdown starts, or send them from another running instance.",
    },
    QUEUE_POSTGRES_INVALID_URL: {
      why: ({ variable }: { variable: string }) => `${variable} is set, and its value is not a \`postgres://\` or \`postgresql://\` URL.`,
      fix: "Set `QUEUE_POSTGRES_URL` to the Postgres URL of the jobs, or remove it to use the connection of the Default Database.",
    },
    QUEUE_POSTGRES_MISSING_CONNECTION: {
      why: ({ database }: { database?: string }) => database
        ? `The postgres queue provider uses the connection of the Database "${database}", and that Database has no Postgres client in this runtime.`
        : "The postgres queue provider has no connection: the build found no Postgres Default Database, and `QUEUE_POSTGRES_URL` is not set.",
      fix: "Add a Default Database with `dialect: 'postgresql'` and build again, or set `QUEUE_POSTGRES_URL` on the server to the Postgres URL of the jobs.",
    },
    QUEUE_RUNTIME_NOT_INSTALLED: {
      why: "The Queue runtime has no client factory. The generated server output installs it.",
      fix: "Set `queue` in `vitehub()`, or add `hubQueue()` to the Vite plugins when you use `@vite-hub/queue` alone. Then build the app and run the built server.",
    },
    QUEUE_VERCEL_SDK_INVALID: {
      why: "`@vercel/queue` does not have the client API that ViteHub uses.",
      fix: "Install a supported `@vercel/queue` version, or pass a `client` that has `send()` and `handleCallback()`.",
    },
    QUEUE_VERCEL_SDK_UNAVAILABLE: {
      why: "`@vercel/queue` or `@vercel/functions` cannot be loaded.",
      fix: "Add `@vercel/queue` and `@vercel/functions` to the app dependencies. Read `error.cause` for the import error.",
    },

    // Definition and build errors. ViteHub throws them when Vite reads the config or builds the app.
    QUEUE_BINDING_CONFLICT: {
      why: "A custom `queue.binding` works with one Queue Definition only, and this app has more.",
      fix: "Remove `queue.binding`, so that each Queue Definition gets its own generated binding.",
    },
    QUEUE_CONTRIBUTION_INVALID: {
      why: ({ message }: { message: string }) => message,
      fix: "Correct the `vitehub.queues` entry of the plugin that the message names. Give it a `name` and `definition: { module }`, where `module` is the absolute path or `file:` URL of a file with `export default defineQueue(...)`.",
    },
    QUEUE_CRYPTO_UNAVAILABLE: {
      why: "Cloudflare queue names for long Queue Definition names need the `node:crypto` module, and this runtime does not have it.",
      fix: "Enable the `nodejs_compat` compatibility flag, or use a shorter Queue Definition name.",
    },
    QUEUE_DEFINITIONS_CHANGED: {
      why: ({ context }: { context: string }) => `The ${context} Queue Definitions changed after Vite resolved the config.`,
      fix: "Generate Queue Definition files before the Vite config resolves, then build again.",
    },
    QUEUE_DEFINITION_DUPLICATE: {
      why: ({ message }: { message: string }) => message,
      fix: "Rename or remove one of the two Queue Definitions that the message lists. Each Queue name must have one file or one plugin contribution.",
    },
    QUEUE_INVALID_CONFIG: {
      why: "`queue` must be a plain object or `false`.",
      fix: "Pass an object, for example `queue: { driver: 'cloudflare' }`.",
    },
    QUEUE_INVALID_DEFINITION: {
      why: ({ reason }: { reason: string }) => reason,
      fix: "Pass one object with a `handler` function and the options next to it, for example `defineQueue({ handler: async ({ payload }) => { ... }, concurrency: 2 })`. Run `npx vitehub migrate` to move the former `defineQueue(handler, options)` form.",
    },
    QUEUE_INVALID_DRIVER: {
      why: ({ driver }: { driver: string }) => `\`queue.driver\` "${driver}" is not a Queue driver.`,
      fix: "Set `queue.driver` to \"cloudflare\", \"vercel\", \"local\", or \"postgres\".",
    },
    QUEUE_INVALID_NAME: {
      why: ({ name }: { name: string }) => `The Cloudflare queue name "${name}" can contain only letters, numbers, and dashes, and must start and end with a letter or number.`,
      fix: "Change `queue.namePrefix` so that it contains only letters, numbers, and dashes.",
    },
    QUEUE_MISSING_DRIVER: {
      why: ({ hosting }: { hosting: string }) => `ViteHub cannot select a Queue driver for ${hosting} hosting.`,
      fix: "Set `queue.driver`, select the Cloudflare, Vercel, or Node deployment preset, or set `queue: false`.",
    },
    QUEUE_NAME_COLLISION: {
      why: ({ first, resolved, second }: { first: string, resolved: string, second: string }) => `The Queue Definitions "${first}" and "${second}" have the same provider name "${resolved}".`,
      fix: "Rename one of the two Queue Definition files.",
    },
    QUEUE_PLUGIN_INCOMPATIBLE: {
      why: "The `hubQueue()` plugin in the Vite config does not expose the Queue Nitro config.",
      fix: "Install one version of `@vite-hub/queue`, and use `hubQueue()` from it.",
    },
    QUEUE_PROVISION_FAILED: {
      why: "Cloudflare returned an invalid queue list during provisioning.",
      fix: "Run `vitehub provision run --host cloudflare --dry-run` again, and check the Cloudflare token permissions.",
    },
    QUEUE_RENAMED_PROVIDER_KEY: {
      why: ({ value }: { value: string }) => `\`queue.provider\` is ${value}. ViteHub renamed this key to \`driver\`, and it does not read \`provider\`, so Queue would not use the driver you chose.`,
      fix: ({ value }: { value: string }) => `Set \`queue: { driver: ${value} }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`,
    },
  },
})
