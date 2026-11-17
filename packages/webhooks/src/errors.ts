import { defineErrors } from "@vite-hub/runtime"

// Keep published codes stable. Keep the codes of each group in alphabetical order.
export const webhooksErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    // Definition and build errors. They throw.
    WEBHOOKS_DATABASE_OFF: {
      why: ({ files }: { files: string }) => `Webhooks keeps each delivery in the Database, but the app has no Database. These files define webhooks: ${files}.`,
      fix: "Turn on `database` in `vitehub()`, or remove the files of `server/webhooks/`.",
    },
    WEBHOOKS_DEBOUNCE_TOO_LONG: {
      why: ({ debounce }: { debounce: string }) => `The debounce ${debounce} is longer than 24 hours. Cloudflare Queues delays a message at most 24 hours, and a webhook must work on every host.`,
      fix: "Set `debounce` to 24 hours or less, such as `\"30 minutes\"`.",
    },
    WEBHOOKS_DEFINITION_INVALID: {
      why: ({ message }: { message: string }) => message,
      fix: "Default-export `defineWebhook({ url: \"T3_WEBHOOK_URL\", secret: \"T3_WEBHOOK_SECRET\" })` from each file of `server/webhooks/`. `url` and `secret` are names of server variables, `signature` is `\"github\"` or `\"stripe\"`, and `debounce` is a duration such as `\"30 minutes\"`.",
    },
    WEBHOOKS_FILE_INVALID: {
      why: ({ message }: { message: string }) => message,
      fix: "Name each file of `server/webhooks/` with lowercase letters, digits, and dashes, such as `t3.ts` or `slack-alerts.ts`, and keep one file for each webhook name.",
    },
    WEBHOOKS_NOT_FOUND: {
      why: ({ name }: { name: string }) => `No webhook is named ${name}.`,
      fix: "Add `server/webhooks/<name>.ts` with `export default defineWebhook({ ... })`, or pass the name of a file that exists. The generated types list every name.",
    },
    WEBHOOKS_NOT_INSTALLED: {
      why: "Webhooks is not running in this server. The app has no `server/webhooks/` files, or the code runs outside the ViteHub server.",
      fix: "Add `server/webhooks/<name>.ts` with `defineWebhook()`, turn on `queue` and `database` in `vitehub()`, and call `sendWebhook()` from server code. In a test, call `installWebhooks()` from `@vite-hub/webhooks/runtime` first.",
    },
    WEBHOOKS_QUEUE_OFF: {
      why: ({ files }: { files: string }) => `Webhooks sends each delivery through the Queue, but the app has no Queue. These files define webhooks: ${files}.`,
      fix: "Turn on `queue` in `vitehub()`, or remove the files of `server/webhooks/`.",
    },

    // Runtime errors. `sendWebhook()` and the delivery functions return them as `[error, undefined]`.
    WEBHOOKS_BODY_INVALID: {
      why: ({ webhook }: { webhook: string }) => `The body for the webhook ${webhook} is not JSON data.`,
      fix: "Pass a plain object, an array, a string, a number, a boolean, or `null`. Convert a `Date` to an ISO string and a `bigint` to a string first.",
    },
    WEBHOOKS_DATABASE_MISSING: {
      why: "Webhooks has no Database in this server.",
      fix: "Turn on `database` in `vitehub()` and add the Default Database.",
    },
    WEBHOOKS_DELIVERY_ACTIVE: {
      why: ({ id, state }: { id: string, state: string }) => `The delivery ${id} is ${state}, so it cannot be delivered again yet.`,
      fix: "Wait until the delivery is sent, dead, or cancelled. To send a pending delivery now, flush it.",
    },
    WEBHOOKS_DELIVERY_FAILED: {
      why: ({ reason, webhook }: { reason: string, webhook: string }) => `The webhook ${webhook} was not delivered: ${reason}.`,
      fix: "Check that the receiver is up and answers with a 2xx status within 10 seconds. The Queue tries the delivery again, and `last_error` of the delivery shows the last failure.",
    },
    WEBHOOKS_DELIVERY_NOT_FOUND: {
      why: ({ id }: { id: string }) => `No webhook delivery has the id ${id}.`,
      fix: "Pass the id of a delivery that `listWebhookDeliveries()` returns.",
    },
    WEBHOOKS_DELIVERY_NOT_PENDING: {
      why: ({ id, state }: { id: string, state: string }) => `The delivery ${id} is ${state}, not pending.`,
      fix: "Flush or cancel only a pending delivery. To send a sent, dead, or cancelled delivery again, redeliver it.",
    },
    WEBHOOKS_SECRET_UNSET: {
      why: ({ name, webhook }: { name: string, webhook: string }) => `The webhook ${webhook} signs each delivery with the secret in \`${name}\`, but this server has no value for it.`,
      fix: "Set the variable to the signing secret that the receiver checks: in `.env` for `vite dev`, and as a secret on the host for production.",
    },
    WEBHOOKS_STORE_FAILED: {
      why: ({ action }: { action: string }) => `Webhooks could not ${action} in the Database.`,
      fix: "Apply the Webhooks table with `vitehub database generate` and `vitehub database migrate`. `error.cause` holds the Database error.",
    },
    WEBHOOKS_URL_INVALID: {
      why: ({ name, webhook }: { name: string, webhook: string }) => `The webhook ${webhook} reads its URL from \`${name}\`, but the value is not an http or https URL.`,
      fix: "Set the variable to the full URL of the receiver, such as `https://example.com/hooks/vitehub`.",
    },
    WEBHOOKS_URL_UNSET: {
      why: ({ name, webhook }: { name: string, webhook: string }) => `The webhook ${webhook} reads its URL from \`${name}\`, but this server has no value for it.`,
      fix: "Set the variable to the URL of the receiver: in `.env` for `vite dev`, and as a secret on the host for production. Keep it secret when the URL holds a token.",
    },
    WEBHOOKS_WAKE_FAILED: {
      why: ({ webhook }: { webhook: string }) => `The delivery of the webhook ${webhook} is stored, but the Queue did not accept its job.`,
      fix: "Read `error.cause` for the Queue error. Flush the pending delivery when the Queue is available again.",
    },
  },
})

/** The codes that `sendWebhook()` returns. Definition errors throw instead. */
export type SendWebhookErrorCode =
  | "WEBHOOKS_BODY_INVALID"
  | "WEBHOOKS_DATABASE_MISSING"
  | "WEBHOOKS_SECRET_UNSET"
  | "WEBHOOKS_STORE_FAILED"
  | "WEBHOOKS_URL_INVALID"
  | "WEBHOOKS_URL_UNSET"
  | "WEBHOOKS_WAKE_FAILED"

/** The codes that the delivery functions of `@vite-hub/webhooks/runtime` return. */
export type WebhookDeliveryErrorCode =
  | "WEBHOOKS_DATABASE_MISSING"
  | "WEBHOOKS_DELIVERY_ACTIVE"
  | "WEBHOOKS_DELIVERY_NOT_FOUND"
  | "WEBHOOKS_DELIVERY_NOT_PENDING"
  | "WEBHOOKS_STORE_FAILED"
  | "WEBHOOKS_WAKE_FAILED"
