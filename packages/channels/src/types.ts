import type { Result } from "@vite-hub/runtime"

import type { channelDefinitionBrand } from "./brand.ts"

type MaybePromise<T> = T | Promise<T>

/** What an adapter's `send()` returns. */
export interface ChannelSendReceipt {
  /** The provider's message ID. */
  id?: string
  raw?: unknown
}

/** What `send()` returns on success. */
export interface ChannelSendResult extends ChannelSendReceipt {
  channel: string
  /** A new ID for each send attempt, for logs. It does not deduplicate sends. */
  deliveryId: string
}

/** Codes of the errors that `send()` returns. */
export type ChannelErrorCode = "CHANNEL_DEFINITION_FAILED" | "CHANNEL_INVALID_SEND" | "CHANNEL_SEND_FAILED"

/**
 * The connection of a Channel to one platform, such as Slack, Teams, Stripe, or your own API.
 * `send` sends one outbound message. Adapters that receive messages carry more data that the Agent package reads.
 */
export interface ChannelAdapter<TSendOptions = never, TMessage = string> {
  /** The platform, such as `"slack"` or `"stripe"`. Logs and the Console show it. */
  readonly kind: string
  /**
   * Sends one message: text, or any object that the adapter accepts, such as a card. Without it,
   * `useChannel(name).send()` returns `CHANNEL_INVALID_SEND`.
   */
  send?: (message: TMessage, options: TSendOptions) => MaybePromise<ChannelSendReceipt>
}

/** The request of an inbound webhook, as the adapter's `event` and `id` functions receive it. */
export interface ChannelWebhookRequest {
  /** Header names are lowercase. */
  headers: Record<string, string>
  method: string
  url: string
}

/** A secret that verifies inbound webhooks. A function runs for each request. `false` turns verification off. */
export type ChannelWebhookSecret =
  | string
  | { unseal: () => string }
  | false
  | (() => MaybePromise<string | { unseal: () => string } | false | undefined>)

/** How an inbound webhook proves that the provider sent it. */
export type ChannelWebhookSignature =
  /** `Authorization: Bearer <secret>`, compared in constant time. */
  | "bearer"
  /** `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body>`. */
  | "github-sha256"
  /** `Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>">`, at most 300 seconds old. */
  | "stripe-sha256"
  | {
    /** `header` carries `prefix` followed by the HMAC-SHA256 of the raw body. */
    preset: "hmac-sha256"
    /** Digest encoding in the header. Defaults to `"hex"`. */
    encoding?: "hex" | "base64"
    /** Text before the digest, such as `"sha256="`. */
    prefix?: string
    /** How `secret` encodes the key. Defaults to `"utf8"`. */
    secretEncoding?: "utf8" | "base64"
  }
  | {
    preset: "stripe-sha256"
    /** Maximum age of the signed timestamp in seconds. Defaults to 300. */
    toleranceSeconds?: number
  }
  | {
    verify: (input: { header: string, rawBody: Uint8Array, request: Request, secret: string }) => MaybePromise<boolean>
  }

/** Options of `webhook()`. */
export interface WebhookAdapterOptions<TData = unknown> {
  /**
   * The provider name that logs and the Console show. Defaults to `"webhook"`.
   */
  kind?: string
  /**
   * Another route for the webhook, next to `/api/_vitehub/channels/<name>`. ViteHub reads it from the source, so it
   * must be a string literal.
   */
  path?: string
  /** More routes, such as an old URL that the provider still calls. String literals. */
  aliases?: string[]
  signature?: ChannelWebhookSignature
  secret?: ChannelWebhookSecret
  /** The header that carries the signature. Each `signature` has a default. */
  header?: string
  /** The name of the event in a request, which selects the `on` target. Defaults to `"webhook"`. */
  event?: (payload: TData, request: ChannelWebhookRequest) => string | undefined
  /** The provider's delivery ID, which deduplicates retries. Defaults to the SHA-256 of the body. */
  id?: (payload: TData, request: ChannelWebhookRequest) => string | undefined
  /**
   * The State and queue scope of the webhook. Set it to an old scope to keep queued deliveries, cursors, and Channel
   * State when a Channel moves.
   */
  stateScope?: string
  /** Rejects requests with 503 unless the Agent State is durable. */
  durableState?: boolean
  /** How long the route can take to answer, in milliseconds. Defaults to 5000. `false` waits for admission. */
  ackTimeoutMs?: number | false
}

declare const channelEventData: unique symbol

/** An adapter that receives webhooks from an HTTP sender, from `webhook()` or `stripe()`. */
export interface WebhookChannelAdapter<TData = unknown> extends ChannelAdapter {
  readonly webhook: Readonly<Omit<WebhookAdapterOptions<TData>, "kind">>
  /** Carries the payload type to `on` handlers. Never set at runtime. */
  readonly [channelEventData]?: TData
}

/** One inbound event, as an `on` handler receives it. */
export interface ChannelEvent<TData = unknown> {
  /** The event name, such as `"checkout.session.completed"`. */
  name: string
  /** The provider's delivery ID. */
  id: string
  /** The parsed JSON body. */
  data: TData
}

/** The second argument of an `on` handler. */
export interface ChannelHandlerContext {
  /** The Channel name. */
  channel: string
}

/**
 * Handles one inbound event after ViteHub stored the delivery. A throw or a returned failed `Result`, such as the
 * result of `sendQueue()`, retries the delivery.
 */
export type ChannelHandler<TData = unknown> = (event: ChannelEvent<TData>, context: ChannelHandlerContext) => unknown

/**
 * A trigger from `defineChannelTrigger()` in `vite-hub/agent/channels`. It decides the delivery ID, `serialize`,
 * `debounce`, and the task or Agent that runs each delivery.
 */
export interface ChannelTrigger {
  invoke: (...args: never[]) => unknown
}

/** The target of one inbound event. */
export type ChannelTarget<TData = unknown> = ChannelHandler<TData> | ChannelTrigger

type AdapterEventData<TAdapter> = TAdapter extends WebhookChannelAdapter<infer TData> ? TData : unknown

/**
 * More Channel options from other packages. `@vite-hub/agent` adds the options that Agents read, such as
 * `instructions`.
 */
export interface ChannelExtensionOptions {}

export interface ChannelDefinitionOptions<TAdapter extends ChannelAdapter<never, never> = ChannelAdapter<never, never>> extends ChannelExtensionOptions {
  /** The connection, such as `stripe()`, `webhook()`, `slack()` from `vite-hub/agent/channels`, or `{ kind, send }`. */
  adapter: TAdapter
  /** Inbound targets by event name: a handler, or a trigger from `defineChannelTrigger()`. */
  on?: Record<string, ChannelTarget<AdapterEventData<TAdapter>>>
}

/** A Channel from `defineChannel()`. */
export type ChannelDefinition<TAdapter extends ChannelAdapter<never, never> = ChannelAdapter<never, never>> = ChannelDefinitionOptions<TAdapter> & {
  readonly [channelDefinitionBrand]: true
}

export interface ChannelDefinitionRegistry {
  [name: string]: () => Promise<{ default?: ChannelDefinitionOptions } | ChannelDefinitionOptions>
}

export interface DiscoveredChannelDefinition {
  handler: string
  name: string
  source: "server-channels" | "vite-suffix"
}

/** The options of the adapter's `send()`. */
export type ChannelSendOptions<TAdapter> = TAdapter extends { send?: (message: never, options: infer TOptions) => unknown } ? TOptions : never

/** The message of the adapter's `send()`: text, or what else the adapter accepts, such as a Chat SDK card. */
export type ChannelMessage<TAdapter> = TAdapter extends { send?: infer TSend }
  ? NonNullable<TSend> extends (message: infer TMessage, options: never) => unknown ? TMessage : string
  : string

type SendArguments<TOptions> = [TOptions] extends [never]
  ? [options?: Record<string, unknown>]
  : undefined extends TOptions ? [options?: TOptions] : [options: TOptions]

export interface ChannelClient<TSendOptions = never, TMessage = string> {
  readonly name: string
  send: (message: TMessage, ...options: SendArguments<TSendOptions>) => Promise<Result<ChannelSendResult, ChannelErrorCode>>
}
