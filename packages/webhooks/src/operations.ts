import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { webhooksErrors } from "./errors.ts"

import type { AnyOperation, OperationContext, OperationDefinition } from "@vite-hub/internal/operations"
import type { Result } from "@vite-hub/runtime"
import type { ListMemberEndpointsOptions, ListWebhookDeliveriesOptions, MemberEndpoint, WebhookDelivery } from "./database.ts"
import type { MemberEndpointWithLastDelivery, SendToMemberEndpointResult } from "./members.ts"
import type { MemberCaller, SendWebhookResult, WebhookInfo } from "./runtime.ts"

// The webhooks live in the Nitro runtime. The operations load it when they run, so the CLI can list them without it.
const runtime = () => import("./runtime.ts")
const members = () => import("./members.ts")

/** The HTTP status that the CLI, the Console, and Agents report for each code of a failed operation. */
const statuses: Readonly<Record<string, number>> = {
  WEBHOOKS_BODY_INVALID: 400,
  WEBHOOKS_DATABASE_MISSING: 409,
  WEBHOOKS_DELIVERY_ACTIVE: 409,
  WEBHOOKS_DELIVERY_NOT_FOUND: 404,
  WEBHOOKS_DELIVERY_NOT_OWNER: 403,
  WEBHOOKS_DELIVERY_NOT_PENDING: 409,
  WEBHOOKS_ENDPOINT_DISABLED: 409,
  WEBHOOKS_ENDPOINT_NOT_FOUND: 404,
  WEBHOOKS_ENDPOINTS_OFF: 409,
  WEBHOOKS_KEY_INVALID: 409,
  WEBHOOKS_KEY_UNSET: 409,
  WEBHOOKS_NOT_FOUND: 404,
  WEBHOOKS_NOT_INSTALLED: 409,
  WEBHOOKS_SECRET_UNSET: 409,
  WEBHOOKS_STORE_FAILED: 500,
  WEBHOOKS_URL_INVALID: 409,
  WEBHOOKS_URL_UNSET: 409,
  WEBHOOKS_WAKE_FAILED: 502,
}

/** Gives a Webhooks error the status that the surfaces report. Other errors pass unchanged. */
function failure(error: unknown): unknown {
  return webhooksErrors.is(error) ? Object.assign(error, { status: statuses[error.code] ?? 500 }) : error
}

/** Runs a runtime function and throws its error, so the operation fails with the code, `why`, and `fix`. */
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

/**
 * Access to the Webhooks section of the Console decides. Most operations never read the signed-in user. Those with
 * `user: true` do: a member delivery goes out again only for the member who owns its endpoint.
 */
function defineWebhooksOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">, options: { user?: true } = {}): OperationDefinition<Input, Output> {
  return defineOperation({ ...definition, cli: { namespace: "webhooks", ...definition.cli }, section: "webhooks", ...options.user ? {} : { user: false as const } })
}

/**
 * The caller of a member action. A call that the ViteHub Console signs names a Console account, which is not an app
 * user, so only its email can match the owner. Any other call names an app user by id.
 */
async function memberCaller(context: OperationContext): Promise<MemberCaller | undefined> {
  const { request, user } = context
  if (!user || context.access.via === "cli" || context.surface === "cli") return undefined
  if (context.access.via !== "console") return { id: user.id }
  const email = user.email?.trim().toLowerCase()
  if (!request || user.emailVerified !== true || !email) return undefined
  const id = await (await runtime()).installedWebhooks()?.resolveVerifiedOwner?.(email, request)
  return id ? { id, verifiedConsoleEmail: email } : undefined
}

/**
 * One member endpoint, as `webhooks.endpoints` lists it for admins: no URL, no secret, and no email. `mine` is true
 * when the caller owns it, so the Console shows Redeliver only on the caller's own deliveries.
 */
export type MemberEndpointRow = Omit<MemberEndpointWithLastDelivery, "ownerEmail"> & { mine: boolean }

/** What the Disable and Enable operations return. */
export type MemberEndpointChange = Pick<MemberEndpoint, "id" | "owner" | "disabledAt" | "disabledBy">

function endpointChange(endpoint: MemberEndpoint): MemberEndpointChange {
  return { id: endpoint.id, owner: endpoint.owner, disabledAt: endpoint.disabledAt, disabledBy: endpoint.disabledBy }
}

/** The name that the Console shows for the person who disabled an endpoint. */
function personLabel(context: OperationContext): string {
  const { user } = context
  if (!user) return context.surface === "cli" ? "the CLI" : "an admin"
  return [user.name, user.email].find((value): value is string => typeof value === "string" && value.trim() !== "") ?? user.id
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
  description: "List webhook deliveries, newest first, with their state, attempts, last status, and last error. A member delivery names its endpoint as @<endpoint id>; owner lists the member's deliveries across endpoint reconnections.",
  input: v.strictObject({
    webhook: v.optional(v.pipe(v.string(), v.minLength(1), v.description("The webhook name, or @<endpoint id> for a member endpoint."))),
    owner: v.optional(v.pipe(v.string(), v.minLength(1), v.description("The member who owns the endpoint, such as the Auth user id."))),
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
  description: "Deliver a pending webhook delivery now, without the rest of its debounce. A member delivery goes out only for the member who owns its endpoint.",
  input: v.strictObject({ id: deliveryId }),
  kind: "write",
  name: "webhooks.flush",
  run: async (input, context) => unwrap(async () => (await runtime()).flushWebhookDelivery(input.id, { resolveCaller: () => memberCaller(context) })),
}, { user: true })

const cancel = defineWebhooksOperation<{ id: string }, WebhookDelivery>({
  cli: { positional: ["id"] },
  description: "Cancel a pending webhook delivery, so it is never sent.",
  input: v.strictObject({ id: deliveryId }),
  kind: "write",
  name: "webhooks.cancel",
  run: async input => unwrap(async () => (await runtime()).cancelWebhookDelivery(input.id)),
})

const redeliver = defineWebhooksOperation<{ id: string }, SendWebhookResult | SendToMemberEndpointResult>({
  cli: { positional: ["id"] },
  description: "Send a sent, dead, or cancelled webhook delivery again now, as a new delivery with the same body and event. A member delivery goes out again only for the member who owns its endpoint; anyone else gets 403.",
  input: v.strictObject({ id: deliveryId }),
  kind: "write",
  name: "webhooks.redeliver",
  run: async (input, context) => unwrap(async () => (await runtime()).redeliverWebhookDelivery(input.id, { resolveCaller: () => memberCaller(context) })),
}, { user: true })

const endpointId = v.pipe(v.string(), v.minLength(1), v.description("The member endpoint id, such as whe_..."))

const endpoints = defineWebhooksOperation<ListMemberEndpointsOptions, MemberEndpointRow[]>({
  description: "List the member endpoints, where each member's agent gets their sends: the owner, the agent, the URL host, and the newest delivery. Never the URL path, the query, the secret, or the owner's email.",
  input: v.strictObject({
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500), v.description("Page size, from 1 to 500. Default: 500."))),
    after: v.optional(v.pipe(v.strictObject({ createdAt: v.number(), id: endpointId }), v.description("The createdAt and id of the last endpoint of the previous page."))),
  }),
  kind: "read",
  name: "webhooks.endpoints",
  run: async (input, context) => {
    const { listMemberEndpoints } = await members()
    const { ownsMemberEndpoint } = await runtime()
    const rows = await unwrap(async () => listMemberEndpoints(input))
    const caller = await memberCaller(context)
    return rows.map(({ ownerEmail, ...row }) => ({ ...row, mine: ownsMemberEndpoint({ owner: row.owner, ownerEmail }, caller) }))
  },
}, { user: true })

const disableEndpoint = defineWebhooksOperation<{ id: string }, MemberEndpointChange>({
  cli: { positional: ["id"] },
  description: "Disable a member endpoint, so the member's sends stop until an admin enables it or the member connects again.",
  input: v.strictObject({ id: endpointId }),
  kind: "write",
  name: "webhooks.disable-endpoint",
  run: async (input, context) => endpointChange(await unwrap(async () => (await members()).disableMemberEndpoint(input.id, { by: personLabel(context) }))),
}, { user: true })

const enableEndpoint = defineWebhooksOperation<{ id: string }, MemberEndpointChange>({
  cli: { positional: ["id"] },
  description: "Enable a member endpoint that an admin disabled, so the member's sends go out again.",
  input: v.strictObject({ id: endpointId }),
  kind: "write",
  name: "webhooks.enable-endpoint",
  run: async input => endpointChange(await unwrap(async () => (await members()).enableMemberEndpoint(input.id))),
})

/**
 * The `webhooks.*` operations. The Console, `vitehub webhooks`, and MCP run them on the app's operation RPC, `POST
 * /_vitehub/rpc`.
 */
export const webhooksOperations: readonly AnyOperation[] = [list, deliveries, pending, get, test, flush, cancel, redeliver, endpoints, disableEndpoint, enableEndpoint]
