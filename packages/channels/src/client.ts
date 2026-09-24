import { defineChannel } from "./definition.ts"

import type { ChannelClient, ChannelConnectorMap, ChannelDefinition, ChannelSendOptions, ChannelSendOutcome } from "./types.ts"
import { channelsErrorDiagnostics } from "./error-diagnostics.ts"

function channelError(message: string): Error {
  return channelsErrorDiagnostics.CHANNELS_R0001({ message: `[vitehub] ${message}` })
}

export function toChannelSendError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function logDelivery(event: string, deliveryId: string, channel: string, connector: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ scope: "vitehub.channel.send", event, deliveryId, channel, connector, ...extra }))
}

export function createChannel<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
>(
  name: string,
  definition: ChannelDefinition<TConnectors, TDefault>,
): ChannelClient<TConnectors, TDefault> {
  defineChannel(definition)

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
        connectorName = (options as { connector?: string }).connector || definition.defaultConnector
        if (!connectorName) {
          throw channelError(`Channel "${name}" requires a connector in send options.`)
        }

        const connector = definition.connectors[connectorName]
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
        logDelivery("outbound.completed", deliveryId, name, connectorName, { messageId: result.id })
        return [null, {
          ...result,
          channel: name,
          connector: connectorName,
          deliveryId,
        }]
      }
      catch (cause) {
        const error = toChannelSendError(cause)
        if (deliveryId && connectorName) logDelivery("outbound.failed", deliveryId, name, connectorName, { error: error.message.slice(0, 2_000) })
        return [error, null]
      }
    },
  }
}
