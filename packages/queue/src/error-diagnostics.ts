import { defineErrors } from "@vite-hub/runtime"

import type { QueueProvider } from "./types.ts"

export type QueueProviderOperation = "create-client" | "send" | "send-batch"

// Keep published codes stable. Each code has a heading on the docs page.
export const queueErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/queue/limits-and-errors",
  codes: {
    // Runtime errors. `send()`, `sendBatch()`, and `runQueue()` return them as `[error, undefined]`.
    QUEUE_PROVIDER_FAILED: {
      why: ({ operation, provider }: { operation: QueueProviderOperation, provider: QueueProvider }) => `The ${provider} queue provider failed during ${operation}.`,
      fix: "Read `error.cause` for the provider error. Retry when the provider is available again. Pass `idempotencyKey` on Vercel so that a retry does not enqueue the job two times.",
    },
    QUEUE_PROVIDER_INVALID_RESPONSE: {
      why: "The Vercel queue provider accepted the job, but returned a missing or invalid `messageId`.",
      fix: "Do not send the job again without an `idempotencyKey`, because the provider can have it. Check the installed `@vercel/queue` version.",
    },
    QUEUE_UNSUPPORTED_OPTION: {
      why: ({ options, provider }: { options: string, provider: QueueProvider }) => `The ${provider} queue provider does not support the enqueue option ${options}.`,
      fix: "Remove the option for this provider. The enqueue options table on the Queue Server API page shows which provider supports each option.",
    },

    // Config errors. An operation throws them when it starts, because the code or the deployment must change.
    QUEUE_BINDING_NOT_FOUND: {
      why: ({ binding }: { binding?: string }) => binding
        ? `The Cloudflare queue binding "${binding}" is not in the Worker env.`
        : "The Cloudflare queue client has no binding.",
      fix: "The dev server has no local Queue delivery. Run the built Worker with `wrangler dev`, or deploy it. In a deployed Worker, add the binding to the Worker configuration.",
    },
    QUEUE_DEFINITION_LOAD_FAILED: {
      why: ({ queue }: { queue?: string }) => queue ? `The Queue Definition "${queue}" failed to load.` : "A Queue Definition failed to load.",
      fix: "Read `error.cause` for the import error, and fix the Queue Definition module.",
    },
    QUEUE_DEFINITION_NOT_FOUND: {
      why: ({ queue }: { queue?: string }) => queue ? `No Queue Definition has the name "${queue}".` : "No Queue Definition has the requested name.",
      fix: "Add `server/queues/<name>.ts` with a default `defineQueue()` export, and build again. The generated server output loads the Queue Definitions, so a script that runs outside of it finds none.",
    },
    QUEUE_DISABLED: {
      why: "Queue is disabled in this runtime.",
      fix: "Add `hubQueue()` to the Vite config and do not set `queue: false`.",
    },
    QUEUE_INVALID_BINDING: {
      why: "The Cloudflare queue binding does not have `send()` and `sendBatch()`.",
      fix: "Pass a Cloudflare Queue producer binding, for example `env.WELCOME_QUEUE`.",
    },
    QUEUE_MISSING_REGION: {
      why: "The installed `@vercel/queue` needs a region, and ViteHub cannot find one.",
      fix: "Set `queue.region` in the Vite config, or set the `QUEUE_REGION` environment variable.",
    },
    QUEUE_MISSING_TOPIC: {
      why: "A direct Vercel queue client needs a `topic`.",
      fix: "Pass `topic` to `createQueueClient()`, or use `getQueue()` for a discovered Queue Definition.",
    },
    QUEUE_PROVIDER_MISMATCH: {
      why: ({ expected, provider }: { expected: QueueProvider, provider: QueueProvider }) => `The ${expected} Queue runtime received the ${provider} provider.`,
      fix: "Set `queue.provider` to the provider of the deployment preset, and build again.",
    },
    QUEUE_RUNTIME_NOT_INSTALLED: {
      why: "The Queue runtime has no client factory. The generated server output installs it.",
      fix: "Add `hubQueue()` to the Vite config, build the app, and run the built server.",
    },
    QUEUE_VERCEL_SDK_INVALID: {
      why: "`@vercel/queue` does not have the client API that ViteHub uses.",
      fix: "Install a supported `@vercel/queue` version, or pass a `client` that has `send()` and `handleCallback()`.",
    },
    QUEUE_VERCEL_SDK_UNAVAILABLE: {
      why: "`@vercel/queue` cannot be loaded.",
      fix: "Add `@vercel/queue` to the app dependencies. Read `error.cause` for the import error.",
    },

    // Definition and build errors. ViteHub throws them when Vite reads the config or builds the app.
    QUEUE_BINDING_CONFLICT: {
      why: "A custom `queue.binding` works with one Queue Definition only, and this app has more.",
      fix: "Remove `queue.binding`, so that each Queue Definition gets its own generated binding.",
    },
    QUEUE_CRYPTO_UNAVAILABLE: {
      why: "Cloudflare queue names for long Queue Definition names need the `node:crypto` module, and this runtime does not have it.",
      fix: "Enable the `nodejs_compat` compatibility flag, or use a shorter Queue Definition name.",
    },
    QUEUE_DEFINITIONS_CHANGED: {
      why: ({ context }: { context: string }) => `The ${context} Queue Definitions changed after Vite resolved the config.`,
      fix: "Generate Queue Definition files before the Vite config resolves, then build again.",
    },
    QUEUE_INVALID_CONFIG: {
      why: "`queue` must be a plain object or `false`.",
      fix: "Pass an object, for example `queue: { provider: 'cloudflare' }`.",
    },
    QUEUE_INVALID_DEFINITION: {
      why: "`defineQueue()` needs a handler function.",
      fix: "Pass the handler as the first argument, for example `defineQueue(async (job) => { ... })`.",
    },
    QUEUE_INVALID_NAME: {
      why: ({ name }: { name: string }) => `The Cloudflare queue name "${name}" can contain only letters, numbers, and dashes, and must start and end with a letter or number.`,
      fix: "Change `queue.namePrefix` so that it contains only letters, numbers, and dashes.",
    },
    QUEUE_INVALID_PROVIDER: {
      why: ({ provider }: { provider: string }) => `\`queue.provider\` "${provider}" is not a Queue provider.`,
      fix: "Set `queue.provider` to \"cloudflare\" or \"vercel\".",
    },
    QUEUE_MISSING_PROVIDER: {
      why: ({ hosting }: { hosting: string }) => `ViteHub cannot select a Queue provider for ${hosting} hosting.`,
      fix: "Set `queue.provider`, select the Cloudflare or Vercel deployment preset, or set `queue: false`.",
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
      fix: "Run `vitehub provision run --provider cloudflare --dry-run` again, and check the Cloudflare token permissions.",
    },
  },
})
