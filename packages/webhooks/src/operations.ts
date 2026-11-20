import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { webhooksErrors } from "./errors.ts"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { Result } from "@vite-hub/runtime"
import type { ListWebhookDeliveriesOptions, WebhookDelivery } from "./database.ts"
import type { SendWebhookResult, WebhookInfo } from "./runtime.ts"

const runtime = () => import("./runtime.ts")

const statuses: Readonly<Record<string, number>> = {
  WEBHOOKS_BODY_INVALID: 400,
  WEBHOOKS_DATABASE_MISSING: 409,
  WEBHOOKS_DELIVERY_ACTIVE: 409,
  WEBHOOKS_DELIVERY_NOT_FOUND: 404,
  WEBHOOKS_DELIVERY_NOT_PENDING: 409,
  WEBHOOKS_NOT_FOUND: 404,
  WEBHOOKS_NOT_INSTALLED: 409,
  WEBHOOKS_SECRET_UNSET: 409,
  WEBHOOKS_STORE_FAILED: 500,
  WEBHOOKS_URL_INVALID: 409,
  WEBHOOKS_URL_UNSET: 409,
  WEBHOOKS_WAKE_FAILED: 502,
}

function failure(error: unknown): unknown {
  return webhooksErrors.is(error) ? Object.assign(error, { status: statuses[error.code] ?? 500 }) : error
}

async function unwrap<T>(run: () => Promise<Result<T, string>>): Promise<T> {
  let result: Result<T, string>
  try {
    result = await run()
  }
  catch (error) {
    throw failure(error)
  }
  if (result[0]) throw failure(result[0])
  return result[1]
}

function defineWebhooksOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  return defineOperation({ ...definition, cli: { namespace: "webhooks", ...definition.cli }, section: "webhooks", user: false })
}

const webhookName = v.pipe(v.string(), v.minLength(1), v.description("The webhook name, the file name of server/webhooks/<name>.ts."))
const deliveryId = v.pipe(v.string(), v.minLength(1), v.description("The delivery id, such as whd_..."))
const limit = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500), v.description("At most this many, from 1 to 500. Default: 100.")))

const list = defineWebhooksOperation<Record<string, never>, WebhookInfo[]>({
  cli: { default: true },
  description: "List the webhooks of the app: the names of their URL and secret variables, whether each is set, the URL host, the signature, and the debounce. Never the URL path, the query, or the secret.",
  input: v.strictObject({}),
  kind: "read",
  name: "webhooks.list",
  run: async () => {
    const { listWebhooks } = await runtime()
    try {
      return listWebhooks()
    }
    catch (error) {
      throw failure(error)
    }
  },
})

const deliveries = defineWebhooksOperation<ListWebhookDeliveriesOptions, WebhookDelivery[]>({
  description: "List webhook deliveries, newest first, with their state, attempts, last status, and last error.",
  input: v.strictObject({
    webhook: v.optional(webhookName),
    state: v.optional(v.picklist(["pending", "sending", "sent", "dead", "cancelled"])),
    limit,
    before: v.optional(v.pipe(v.strictObject({ createdAt: v.number(), id: v.string() }), v.description("The createdAt and id of the last delivery of the previous page."))),
  }),
  kind: "read",
  name: "webhooks.deliveries",
  run: async input => unwrap(async () => (await runtime()).listWebhookDeliveries(input)),
})

const pending = defineWebhooksOperation<{ webhook?: string, limit?: number }, WebhookDelivery[]>({
  description: "List the pending webhook deliveries, the soonest due first: the debounce timers that wait now.",
  input: v.strictObject({ webhook: v.optional(webhookName), limit }),
  kind: "read",
  name: "webhooks.pending",
  run: async input => unwrap(async () => (await runtime()).listPendingWebhookDeliveries(input)),
})

const get = defineWebhooksOperation<{ id: string }, WebhookDelivery>({
  cli: { positional: ["id"] },
  description: "Show one webhook delivery with its body.",
  input: v.strictObject({ id: deliveryId }),
  kind: "read",
  name: "webhooks.get",
  run: async input => unwrap(async () => (await runtime()).getWebhookDelivery(input.id)),
})

const test = defineWebhooksOperation<{ name: string, body?: unknown }, SendWebhookResult>({
  cli: { positional: ["name"] },
  description: "Send a test delivery to a webhook now, without its debounce, with the event webhooks.test. The body is a JSON value; the default is { test: true, webhook: <name> }.",
  input: v.strictObject({ name: webhookName, body: v.optional(v.unknown()) }),
  kind: "write",
  name: "webhooks.test",
  run: async input => unwrap(async () => (await runtime()).testWebhook(input.name, input.body === undefined ? {} : { body: input.body })),
})

const flush = defineWebhooksOperation<{ id: string }, WebhookDelivery>({
  cli: { positional: ["id"] },
  description: "Deliver a pending webhook delivery now, without the rest of its debounce.",
  input: v.strictObject({ id: deliveryId }),
  kind: "write",
  name: "webhooks.flush",
  run: async input => unwrap(async () => (await runtime()).flushWebhookDelivery(input.id)),
})

const cancel = defineWebhooksOperation<{ id: string }, WebhookDelivery>({
  cli: { positional: ["id"] },
  description: "Cancel a pending webhook delivery, so it is never sent.",
  input: v.strictObject({ id: deliveryId }),
  kind: "write",
  name: "webhooks.cancel",
  run: async input => unwrap(async () => (await runtime()).cancelWebhookDelivery(input.id)),
})

const redeliver = defineWebhooksOperation<{ id: string }, SendWebhookResult>({
  cli: { positional: ["id"] },
  description: "Send a sent, dead, or cancelled webhook delivery again now, as a new delivery with the same body and event.",
  input: v.strictObject({ id: deliveryId }),
  kind: "write",
  name: "webhooks.redeliver",
  run: async input => unwrap(async () => (await runtime()).redeliverWebhookDelivery(input.id)),
})

/**
 * The `webhooks.*` operations. The Console, `vitehub webhooks`, and MCP run them on the app's operation RPC, `POST
 * /_vitehub/rpc`.
 */
export const webhooksOperations: readonly AnyOperation[] = [list, deliveries, pending, get, test, flush, cancel, redeliver]
