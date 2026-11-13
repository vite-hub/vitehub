import { defineChannel, isChannelDefinition } from "./definition.ts"

import type { Result } from "@vite-hub/runtime"

import type { ChannelAdapter, ChannelClient, ChannelDefinitionOptions, ChannelErrorCode, ChannelMessage, ChannelSendOptions, ChannelSendReceipt, ChannelSendResult } from "./types.ts"
import { channelErrors } from "./error-diagnostics.ts"

const uninspectableSendErrorMessage = "Channel send failed with an uninspectable value."

function toError(cause: unknown): Error {
  try {
    const isError = "isError" in Error && typeof Error.isError === "function"
      ? Error.isError(cause) === true
      : cause instanceof Error
    if (isError) return cause as Error
    return new Error(String(cause))
  }
  catch {
    return new Error(uninspectableSendErrorMessage)
  }
}

function channelSendErrorMessage(error: Error): string {
  try {
    const message = error.message
    if (typeof message === "string") return message.slice(0, 2_000)
  }
  catch {
    // Connector error getters and proxies can throw while reading the message.
  }
  return uninspectableSendErrorMessage
}

function logDelivery(event: string, deliveryId: string, channel: string, kind: string, extra?: () => Record<string, unknown>): void {
  try {
    console.info(JSON.stringify({ scope: "vitehub.channel.send", event, deliveryId, channel, kind, ...extra?.() }))
  }
  catch {
    // Logging must not change delivery results or encourage retrying a delivered message.
  }
}

function normalizeSendReceipt(result: object): ChannelSendReceipt {
  const entries: Array<[PropertyKey, unknown]> = []
  try {
    for (const key of Reflect.ownKeys(result)) {
      if (key === "id") continue
      try {
        if (Object.prototype.propertyIsEnumerable.call(result, key)) entries.push([key, Reflect.get(result, key)])
      }
      catch {
        // Optional metadata must not turn an accepted delivery into a retry.
      }
    }
  }
  catch {
    // An adapter proxy can reject enumeration while still exposing its ID.
  }
  const normalized: ChannelSendReceipt = Object.fromEntries(entries)
  try {
    const id: unknown = Reflect.get(result, "id")
    if (typeof id === "string") normalized.id = id
  }
  catch {
    // Delivery already succeeded. An inaccessible optional ID must not encourage a resend.
  }
  return normalized
}

/** A client that sends through the Channel's adapter. `useChannel()` returns the same client for discovered Channels. */
export function createChannel<TAdapter extends ChannelAdapter<never, never>>(
  name: string,
  definition: ChannelDefinitionOptions<TAdapter>,
): ChannelClient<ChannelSendOptions<TAdapter>, ChannelMessage<TAdapter>> {
  const { adapter } = isChannelDefinition(definition) ? definition : defineChannel(definition)

  return {
    name,
    async send(message: unknown, options?: unknown): Promise<Result<ChannelSendResult, ChannelErrorCode>> {
      const invalid = (detail: string): Result<ChannelSendResult, ChannelErrorCode> => [channelErrors.CHANNEL_INVALID_SEND({ detail }), undefined]
      // Text must have content. The adapter checks the shape of an object message, such as a card.
      if (typeof message === "string" ? message.trim().length === 0 : (!message || typeof message !== "object" || Array.isArray(message))) {
        return invalid("Channel message must be non-empty text or an object that the adapter accepts.")
      }
      if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) {
        return invalid(`Channel "${name}" send options must be an object.`)
      }
      const send = adapter.send
      if (typeof send !== "function") {
        return invalid(`Channel "${name}" cannot send: its "${adapter.kind}" adapter only receives messages.`)
      }

      const deliveryId = globalThis.crypto.randomUUID()
      try {
        logDelivery("outbound.started", deliveryId, name, adapter.kind)
        // SAFETY: ChannelClient types the message and options as the adapter's send arguments.
        const result: unknown = await send.call(adapter, message as never, (options ?? {}) as never)
        if (!result || typeof result !== "object") {
          throw new Error(`The "${adapter.kind}" adapter of Channel "${name}" returned an invalid result.`)
        }
        const normalized = normalizeSendReceipt(result)
        logDelivery("outbound.completed", deliveryId, name, adapter.kind, () => ({ messageId: normalized.id }))
        return [undefined, { ...normalized, channel: name, deliveryId }]
      }
      catch (thrown) {
        const cause = toError(thrown)
        logDelivery("outbound.failed", deliveryId, name, adapter.kind, () => ({ error: channelSendErrorMessage(cause) }))
        return [channelErrors.CHANNEL_SEND_FAILED({ cause, channel: name, kind: adapter.kind }), undefined]
      }
    },
  } as ChannelClient<ChannelSendOptions<TAdapter>, ChannelMessage<TAdapter>>
}
