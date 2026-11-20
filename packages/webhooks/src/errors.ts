import { defineErrors } from "@vite-hub/runtime"

// Keep published codes stable. Keep the codes of each group in alphabetical order.
export const webhooksErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/webhooks/diagnostics",
  codes: {
    // Definition and build errors. They throw.
    WEBHOOKS_CONTRIBUTION_INVALID: {
      why: ({ plugin }: { plugin: string }) => `The Vite plugin ${plugin} sets \`vitehub.webhooks\`, but not to \`{ memberEndpoints: true, reason }\` or a function that returns it.`,
      fix: "Set `vitehub.webhooks` to `{ memberEndpoints: true, reason: \"...\" }`, or to a function that returns it, or `undefined` when the feature is off.",
    },
    WEBHOOKS_DATABASE_OFF: {
      why: ({ users }: { users: string }) => `Webhooks keeps each delivery in the Database, but the app has no Database. These use Webhooks: ${users}.`,
      fix: "Turn on `database` in `vitehub()`, or remove the files of `server/webhooks/` and turn off the features that use member endpoints.",
    },
    WEBHOOKS_DEBOUNCE_TOO_LONG: {
      why: ({ debounce }: { debounce: string }) => `The debounce ${debounce} is longer than 24 hours. Cloudflare Queues delays a message at most 24 hours, and a webhook must work on every host.`,
      fix: "Set `debounce` to 24 hours or less, such as `\"30m\"` or `\"1d\"`.",
    },
    WEBHOOKS_DEFINITION_INVALID: {
      why: ({ message }: { message: string }) => message,
      fix: "Default-export `defineWebhook({ url: \"T3_WEBHOOK_URL\", secret: \"T3_WEBHOOK_SECRET\" })` from each file of `server/webhooks/`. `url` and `secret` are names of server variables, `signature` is `\"github\"` or `\"stripe\"`, `debounce` is a duration such as `\"30m\"`, and `events` lists `\"invocation.failed\"`, `\"workflow.failed\"`, or `\"schedule.failed\"`.",
    },
    WEBHOOKS_ENDPOINTS_OFF: {
      why: "Member endpoints are not on in this server. No feature of the app uses them, or the code runs outside the ViteHub server.",
      fix: "Turn on a feature that uses member endpoints, such as `send: true` in `defineComments()`. In a test, call `installWebhooks({ webhooks: {}, store, endpoints })` from `@vite-hub/webhooks/runtime` first.",
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
    WEBHOOKS_DELIVERY_NOT_OWNER: {
      why: ({ id }: { id: string }) => `The delivery ${id} went to the agent of a member, and only that member can send it again.`,
      fix: "Ask the member to redeliver it. In the ViteHub Console, the member signs in with the email of their app account, which must be verified. An app sends again as the member with `redeliverWebhookDelivery(id, { caller: { id: user.id } })`.",
    },
    WEBHOOKS_DELIVERY_NOT_PENDING: {
      why: ({ id, state }: { id: string, state: string }) => `The delivery ${id} is ${state}, not pending.`,
      fix: "Flush or cancel only a pending delivery. To send a sent, dead, or cancelled delivery again, redeliver it.",
    },
    WEBHOOKS_ENDPOINT_DISABLED: {
      why: ({ id }: { id: string }) => `The member endpoint ${id} is disabled, so Webhooks does not send to it.`,
      fix: "Ask the member to connect their agent again. That replaces the endpoint with a new one.",
    },
    WEBHOOKS_ENDPOINT_INVALID: {
      why: ({ problem }: { problem: string }) => `The member endpoint is not valid: ${problem}.`,
      fix: "Pass `{ owner, name, kind: \"url\", url, secret }` for a receiver URL, or `{ owner, name, kind: \"inbox\" }` for an agent that reads its inbox. `owner` and `name` are non-empty text.",
    },
    WEBHOOKS_ENDPOINT_NOT_FOUND: {
      why: ({ match }: { match: string }) => `No member endpoint has ${match}.`,
      fix: "Create one with `createMemberEndpoint()` first. `getMemberEndpoint(owner)` returns the endpoint of a member.",
    },
    WEBHOOKS_KEY_INVALID: {
      why: ({ problem }: { problem: string }) => `\`VITEHUB_WEBHOOKS_KEY\` cannot seal or open member endpoints: ${problem}.`,
      fix: "Set `VITEHUB_WEBHOOKS_KEY` to 32 random bytes in base64, from `openssl rand -base64 32`. A new key cannot open the endpoints that the old key sealed, so members connect again after a change.",
    },
    WEBHOOKS_KEY_UNSET: {
      why: "Webhooks seals the URL and secret of each member endpoint with `VITEHUB_WEBHOOKS_KEY`, but this server has no value for it.",
      fix: "Set `VITEHUB_WEBHOOKS_KEY` to the output of `openssl rand -base64 32`, as a secret on the host. `vite dev` generates one in `.vitehub/data/webhooks-key`.",
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
    WEBHOOKS_URL_REFUSED: {
      why: ({ reason }: { reason: string }) => `Webhooks does not send a signed body to this URL: ${reason}.`,
      fix: "Use an `https` URL on a public host, with no user name or password, such as `https://relay.t3.codes/hooks/...`. A member endpoint also needs a host of its allowlist.",
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

/** The codes that `createMemberEndpoint()` returns. */
export type CreateMemberEndpointErrorCode =
  | "WEBHOOKS_DATABASE_MISSING"
  | "WEBHOOKS_ENDPOINT_INVALID"
  | "WEBHOOKS_KEY_INVALID"
  | "WEBHOOKS_KEY_UNSET"
  | "WEBHOOKS_STORE_FAILED"
  | "WEBHOOKS_URL_REFUSED"

/** The codes that `getMemberEndpoint()`, `listMemberEndpoints()`, `removeMemberEndpoint()`, `disableMemberEndpoint()`, and `enableMemberEndpoint()` return. */
export type MemberEndpointErrorCode =
  | "WEBHOOKS_DATABASE_MISSING"
  | "WEBHOOKS_ENDPOINT_NOT_FOUND"
  | "WEBHOOKS_STORE_FAILED"

/** The codes that `sendToMemberEndpoint()` returns. A failed post is not an error: it returns `status: "failed"`. */
export type SendToMemberEndpointErrorCode =
  | "WEBHOOKS_BODY_INVALID"
  | "WEBHOOKS_DATABASE_MISSING"
  | "WEBHOOKS_ENDPOINT_DISABLED"
  | "WEBHOOKS_ENDPOINT_NOT_FOUND"
  | "WEBHOOKS_KEY_INVALID"
  | "WEBHOOKS_KEY_UNSET"
  | "WEBHOOKS_STORE_FAILED"
  | "WEBHOOKS_URL_REFUSED"
  | "WEBHOOKS_WAKE_FAILED"

/**
 * The codes that the delivery functions of `@vite-hub/webhooks/runtime` return. The member codes come only from a
 * delivery to a member endpoint.
 */
export type WebhookDeliveryErrorCode =
  | "WEBHOOKS_DATABASE_MISSING"
  | "WEBHOOKS_DELIVERY_ACTIVE"
  | "WEBHOOKS_DELIVERY_NOT_FOUND"
  | "WEBHOOKS_DELIVERY_NOT_OWNER"
  | "WEBHOOKS_DELIVERY_NOT_PENDING"
  | "WEBHOOKS_ENDPOINT_DISABLED"
  | "WEBHOOKS_ENDPOINT_NOT_FOUND"
  | "WEBHOOKS_KEY_INVALID"
  | "WEBHOOKS_KEY_UNSET"
  | "WEBHOOKS_STORE_FAILED"
  | "WEBHOOKS_WAKE_FAILED"
