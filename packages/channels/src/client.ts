import { defineOutboundChannel } from "./definition.ts"

import type { ChannelClient, ChannelConnectorMap, ChannelConnectorResult, ChannelDefinition, ChannelSendOptions, ChannelSendOutcome } from "./types.ts"
import { channelsErrorDiagnostics } from "./error-diagnostics.ts"

const uninspectableSendErrorMessage = "Channel send failed with an uninspectable value."

function channelError(message: string): Error {
  return channelsErrorDiagnostics.CHANNELS_R0001({ message: `[vitehub] ${message}` })
}

export function toChannelSendError(cause: unknown): Error {
  try {
    return cause instanceof Error ? cause : new Error(String(cause))
  }
  catch {
    return new Error(uninspectableSendErrorMessage)
  }
}

function channelSendErrorMessage(error: Error): string {
  try {
    const message = error.message
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connector errors can carry non-string messages from JavaScript.
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

function normalizeConnectorResult(result: ChannelConnectorResult): ChannelConnectorResult {
  const normalized: ChannelConnectorResult = Object.fromEntries(Reflect.ownKeys(result)
    .filter(key => key !== "id" && Object.prototype.propertyIsEnumerable.call(result, key))
    .map(key => [key, Reflect.get(result, key)]))
  try {
    const id = result.id
    if (id !== undefined) normalized.id = id
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
    async send(text: string, options: ChannelSendOptions<TConnectors, TDefault>): Promise<ChannelSendOutcome> {
      let deliveryId: string | undefined
      let connectorName: string | undefined
      try {
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Public send can receive invalid JavaScript input.
        if (typeof text !== "string" || text.trim().length === 0) {
          throw channelError("Channel message text must be a non-empty string.")
        }

        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Public send validates JavaScript options before reading the selector.
        if (!options || typeof options !== "object") {
          throw channelError(`Channel "${name}" send options must select a connector.`)
        }

        // SAFETY: The object check above establishes that options can carry a connector selector.
        const requestedConnector = (options as { connector?: unknown }).connector
        const selectedConnector = requestedConnector === undefined ? definition.defaultConnector : requestedConnector
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Reject malformed JavaScript selectors before resolving a configured connector.
        if (typeof selectedConnector !== "string" || selectedConnector.length === 0) {
          throw channelError(`Channel "${name}" requires a connector in send options.`)
        }
        connectorName = selectedConnector

        const connector = Object.hasOwn(definition.connectors, connectorName)
          ? definition.connectors[connectorName]
          : undefined
        if (!connector) {
          throw channelError(`Channel "${name}" does not define connector "${connectorName}".`)
        }

        // SAFETY: The object check above establishes that options can be copied into connector options.
        const connectorOptions = { ...(options as Record<string, unknown>) }
        delete connectorOptions.connector
        deliveryId = globalThis.crypto.randomUUID()
        logDelivery("outbound.started", deliveryId, name, connectorName)
        const result = await connector.send(text, connectorOptions as never)
        if (!result || typeof result !== "object") {
          throw channelError(`Channel connector "${connectorName}" returned an invalid result.`)
        }
        const normalized = normalizeConnectorResult(result)
        logDelivery("outbound.completed", deliveryId, name, connectorName, () => ({ messageId: normalized.id }))
        return [null, {
          ...normalized,
          channel: name,
          connector: connectorName,
          deliveryId,
        }]
      }
      catch (cause) {
        const error = toChannelSendError(cause)
        if (deliveryId && connectorName) logDelivery("outbound.failed", deliveryId, name, connectorName, () => ({ error: channelSendErrorMessage(error) }))
        return [error, null]
      }
    },
  }
}
