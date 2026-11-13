import type { ChannelWebhookSecret, WebhookAdapterOptions, WebhookChannelAdapter } from "./types.ts"

/**
 * Receives webhooks from any HTTP sender. ViteHub checks the signature, stores the delivery, deduplicates it by
 * delivery ID, and retries the `on` target until it succeeds. Set `signature` and `secret`. Only `secret: false`
 * accepts requests without verification.
 *
 * @example
 * export default defineChannel({
 *   adapter: webhook({ signature: 'bearer', secret: () => useServerEnv().prefect.webhookSecret }),
 *   on: { webhook: event => sendQueue('triage', event.data) },
 * })
 */
export function webhook<TData = unknown>(options: WebhookAdapterOptions<TData>): WebhookChannelAdapter<TData> {
  const { kind = "webhook", ...webhookOptions } = options
  return { kind, webhook: webhookOptions }
}

/** A Stripe event, as Stripe sends it to a webhook endpoint. */
export interface StripeEvent<TObject = Record<string, unknown>> {
  id: string
  object: "event"
  api_version?: string | null
  created: number
  data: {
    object: TObject
    previous_attributes?: Record<string, unknown>
  }
  livemode: boolean
  pending_webhooks: number
  request?: { id: string | null, idempotency_key: string | null } | null
  type: string
}

export interface StripeAdapterOptions {
  /** The endpoint's signing secret (`whsec_...`). Defaults to the `STRIPE_WEBHOOK_SECRET` environment variable. */
  secret?: ChannelWebhookSecret
  /** Another route next to `/api/_vitehub/channels/<name>`. A string literal. */
  path?: string
  /** The old webhook State and queue scope to keep when this Channel moves. */
  stateScope?: WebhookAdapterOptions<StripeEvent>["stateScope"]
  /** Maximum age of the signed timestamp in seconds. Defaults to 300. */
  toleranceSeconds?: number
}

function stripeWebhookSecret(): string | undefined {
  return typeof process === "undefined" ? undefined : process.env.STRIPE_WEBHOOK_SECRET
}

/**
 * Receives Stripe webhooks. The `on` keys are Stripe event types, and the event ID deduplicates retries.
 *
 * @example
 * export default defineChannel({
 *   adapter: stripe(),
 *   on: { 'checkout.session.completed': event => sendQueue('fulfil', event.data) },
 * })
 */
export function stripe(options: StripeAdapterOptions = {}): WebhookChannelAdapter<StripeEvent> {
  return webhook<StripeEvent>({
    kind: "stripe",
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.stateScope === undefined ? {} : { stateScope: options.stateScope }),
    signature: options.toleranceSeconds === undefined ? "stripe-sha256" : { preset: "stripe-sha256", toleranceSeconds: options.toleranceSeconds },
    secret: options.secret ?? stripeWebhookSecret,
    event: payload => typeof payload?.type === "string" ? payload.type : undefined,
    id: payload => typeof payload?.id === "string" ? payload.id : undefined,
  })
}
