import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"
import type { WebhookDelivery } from "../../packages/webhooks/src/database.ts"
import type { WebhookInfo } from "../../packages/webhooks/src/runtime.ts"

const minute = 60_000
const start = Date.now()

const webhooks: WebhookInfo[] = [
  { debounceMs: 30 * minute, host: "t3.example.com", name: "t3", secret: "T3_WEBHOOK_SECRET", secretSet: true, signature: "github", url: "T3_WEBHOOK_URL", urlSet: true },
  { debounceMs: 0, host: "hooks.slack.com", name: "slack-alerts", secret: "SLACK_ALERTS_SECRET", secretSet: false, signature: "github", url: "SLACK_ALERTS_URL", urlSet: true },
  { debounceMs: 5 * minute, host: null, name: "billing", secret: "BILLING_WEBHOOK_SECRET", secretSet: false, signature: "stripe", url: "BILLING_WEBHOOK_URL", urlSet: false },
]

let sequence = 0
function delivery(fields: Partial<WebhookDelivery> & Pick<WebhookDelivery, "event" | "state" | "webhook">, ago: number): WebhookDelivery {
  const createdAt = start - ago
  return {
    attempts: 0,
    body: { event: fields.event, page: "/pricing", threadId: `thr_${++sequence}` },
    count: 1,
    createdAt,
    dueAt: createdAt,
    id: `whd_0f3c${String(sequence).padStart(2, "0")}a1-7b2e-4d6f-9c8a-${String(sequence).padStart(12, "0")}`,
    key: null,
    lastError: null,
    lastStatus: null,
    revision: 1,
    sentAt: null,
    updatedAt: createdAt,
    ...fields,
  }
}

const deliveries: WebhookDelivery[] = [
  delivery({ count: 4, dueAt: start + 21 * minute, event: "comments.created", key: "page:/pricing", revision: 4, state: "pending", webhook: "t3" }, 9 * minute),
  delivery({ count: 1, dueAt: start + 2 * minute + 30_000, event: "comments.created", key: "page:/docs/queue", state: "pending", webhook: "t3" }, 27 * minute),
  delivery({ count: 2, dueAt: start + 4 * minute, event: "invoice.paid", key: "customer:cus_9f2", revision: 2, state: "pending", webhook: "billing" }, minute),
  delivery({ attempts: 1, count: 6, event: "comments.created", key: "page:/blog/launch", lastStatus: 200, sentAt: start - 12 * minute, state: "sent", updatedAt: start - 12 * minute, webhook: "t3" }, 42 * minute),
  delivery({ attempts: 1, event: "forms.submitted", lastError: "SLACK_ALERTS_SECRET is not set on this server.", state: "dead", updatedAt: start - 40 * minute, webhook: "slack-alerts" }, 40 * minute),
  delivery({ attempts: 4, event: "comments.resolved", key: "page:/changelog", lastStatus: 502, state: "dead", updatedAt: start - 2 * 60 * minute, webhook: "t3" }, 3 * 60 * minute),
  delivery({ attempts: 1, body: { test: true, webhook: "t3" }, event: "webhooks.test", lastStatus: 204, sentAt: start - 3 * 60 * minute, state: "sent", updatedAt: start - 3 * 60 * minute, webhook: "t3" }, 3 * 60 * minute),
  delivery({ count: 2, event: "comments.created", key: "page:/about", state: "cancelled", updatedAt: start - 5 * 60 * minute, webhook: "t3" }, 6 * 60 * minute),
  delivery({ attempts: 2, count: 3, event: "comments.created", key: "page:/pricing", lastStatus: 200, sentAt: start - 26 * 60 * minute, state: "sent", updatedAt: start - 26 * 60 * minute, webhook: "t3" }, 27 * 60 * minute),
]

const fail = (status: number, code: string, message: string, fix?: string): ConsoleRpcResult => ({ code, message, ok: false, status, ...(fix ? { fix } : {}) })
const notFound = (id: unknown) => fail(404, "WEBHOOKS_DELIVERY_NOT_FOUND", `No webhook delivery has the id ${String(id)}.`)

function send(entry: WebhookDelivery): void {
  const now = Date.now()
  Object.assign(entry, { attempts: entry.attempts + 1, dueAt: now, lastError: null, lastStatus: 200, sentAt: now, state: "sent", updatedAt: now })
}

export function webhooksFixture(operation: string, input: Record<string, unknown>): ConsoleRpcResult | undefined {
  if (!operation.startsWith("webhooks.")) return undefined
  const found = typeof input.id === "string" ? deliveries.find(entry => entry.id === input.id) : undefined
  switch (operation) {
    case "webhooks.list":
      return { ok: true, value: structuredClone(webhooks) }
    case "webhooks.pending":
      return { ok: true, value: structuredClone(deliveries.filter(entry => entry.state === "pending").sort((left, right) => left.dueAt - right.dueAt)) }
    case "webhooks.deliveries": {
      const state = typeof input.state === "string" ? input.state : undefined
      const limit = typeof input.limit === "number" ? input.limit : 100
      const listed = deliveries.filter(entry => (!state || entry.state === state) && (!input.webhook || entry.webhook === input.webhook))
      return { ok: true, value: structuredClone(listed.sort((left, right) => right.createdAt - left.createdAt).slice(0, limit)) }
    }
    case "webhooks.get":
      return found ? { ok: true, value: structuredClone(found) } : notFound(input.id)
    case "webhooks.test": {
      const webhook = webhooks.find(entry => entry.name === input.name)
      if (!webhook) return fail(404, "WEBHOOKS_NOT_FOUND", `The app has no webhook ${JSON.stringify(input.name)}.`)
      if (!webhook.urlSet) return fail(409, "WEBHOOKS_URL_UNSET", `${webhook.url} is not set.`, `Set ${webhook.url} in the Env of this app.`)
      if (!webhook.secretSet) return fail(409, "WEBHOOKS_SECRET_UNSET", `${webhook.secret} is not set.`, `Set ${webhook.secret} in the Env of this app.`)
      const entry = delivery({ body: { test: true, webhook: webhook.name }, event: "webhooks.test", state: "pending", webhook: webhook.name }, start - Date.now())
      send(entry)
      deliveries.push(entry)
      return { ok: true, value: { id: entry.id, status: "pending" } }
    }
    case "webhooks.flush":
    case "webhooks.cancel": {
      if (!found) return notFound(input.id)
      if (found.state !== "pending") return fail(409, "WEBHOOKS_DELIVERY_NOT_PENDING", `The delivery ${found.id} is ${found.state}, not pending.`)
      if (operation === "webhooks.flush") send(found)
      else Object.assign(found, { state: "cancelled", updatedAt: Date.now() })
      return { ok: true, value: structuredClone(found) }
    }
    case "webhooks.redeliver": {
      if (!found) return notFound(input.id)
      if (found.state === "pending" || found.state === "sending") return fail(409, "WEBHOOKS_DELIVERY_ACTIVE", `The delivery ${found.id} is still ${found.state}.`)
      const entry = delivery({ body: structuredClone(found.body), count: found.count, event: found.event, state: "pending", webhook: found.webhook }, start - Date.now())
      send(entry)
      deliveries.push(entry)
      return { ok: true, value: { id: entry.id, status: "pending" } }
    }
    default:
      return fail(404, "CONSOLE_REQUEST_INVALID", `The playground has no fixture for ${operation}.`)
  }
}
