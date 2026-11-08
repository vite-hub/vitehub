import { defineOutboundChannel } from "./definition.ts"

import type { Result } from "@vite-hub/runtime"

import type { ChannelClient, ChannelConnectorMap, ChannelConnectorResult, ChannelDefinition, ChannelErrorCode, ChannelSendOptions, ChannelSendResult } from "./types.ts"
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

function logDelivery(event: string, deliveryId: string, channel: string, connector: string, extra?: () => Record<string, unknown>): void {
  try {
    console.info(JSON.stringify({ scope: "vitehub.channel.send", event, deliveryId, channel, connector, ...extra?.() }))
  }
  catch {
    // Logging must not change delivery results or encourage retrying a delivered message.
  }
}

function normalizeConnectorResult(result: object): ChannelConnectorResult {
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
    // A connector proxy can reject enumeration while still exposing its ID.
  }
  const normalized: ChannelConnectorResult = Object.fromEntries(entries)
  try {
    const id: unknown = Reflect.get(result, "id")
    if (typeof id === "string") normalized.id = id
  }
  catch {
    // Delivery already succeeded. An inaccessible optional ID must not encourage a resend.
  }
  return normalized
}

export function createChannel<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
>(
  name: string,
  definition: ChannelDefinition<TConnectors, TDefault>,
): ChannelClient<TConnectors, TDefault> {
  defineOutboundChannel(definition)

  return {
    name,
    async send(text: string, options: ChannelSendOptions<TConnectors, TDefault>): Promise<Result<ChannelSendResult, ChannelErrorCode>> {
      const invalid = (detail: string): Result<ChannelSendResult, ChannelErrorCode> => [channelErrors.CHANNEL_INVALID_SEND({ detail }), undefined]
      if (typeof text !== "string" || text.trim().length === 0) {
        return invalid("Channel message text must be a non-empty string.")
      }

      if (!options || typeof options !== "object" || Array.isArray(options)) {
        return invalid(`Channel "${name}" send options must select a connector.`)
      }

      // SAFETY: The object check above establishes that options can carry a connector selector.
      const requestedConnector = (options as { connector?: unknown }).connector
      const connectorName = requestedConnector === undefined ? definition.defaultConnector : requestedConnector
      if (typeof connectorName !== "string" || connectorName.length === 0) {
        return invalid(`Channel "${name}" requires a connector in send options.`)
      }

      const connector = Object.hasOwn(definition.connectors, connectorName)
        ? definition.connectors[connectorName]
        : undefined
      if (!connector) {
        return invalid(`Channel "${name}" does not define connector "${connectorName}".`)
      }

      const deliveryId = globalThis.crypto.randomUUID()
      try {
        logDelivery("outbound.started", deliveryId, name, connectorName)
        // SAFETY: ChannelSendOptions carries the selected connector's options; selector validation above resolves that connector.
        const result = await connector.send(text, options as never)
        if (!result || typeof result !== "object") {
          throw new Error(`Channel connector "${connectorName}" returned an invalid result.`)
        }
        const normalized = normalizeConnectorResult(result)
        logDelivery("outbound.completed", deliveryId, name, connectorName, () => ({ messageId: normalized.id }))
        return [undefined, {
          ...normalized,
          channel: name,
          connector: connectorName,
          deliveryId,
        }]
      }
      catch (thrown) {
        const cause = toError(thrown)
        logDelivery("outbound.failed", deliveryId, name, connectorName, () => ({ error: channelSendErrorMessage(cause) }))
        return [channelErrors.CHANNEL_SEND_FAILED({ cause, channel: name, connector: connectorName }), undefined]
      }
    },
  }
}
