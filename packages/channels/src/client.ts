import { defineChannel } from "./definition.ts"

import type { ChannelClient, ChannelConnectorMap, ChannelDefinition, ChannelSendOptions, ChannelSendResult } from "./types.ts"

function channelError(message: string): Error {
  return new Error(`[vitehub] ${message}`)
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
    async send(text: string, options: ChannelSendOptions<TConnectors, TDefault>): Promise<ChannelSendResult> {
      if (typeof text !== "string" || text.trim().length === 0) {
        throw channelError("Channel message text must be a non-empty string.")
      }

      if (!options || typeof options !== "object") {
        throw channelError(`Channel "${name}" send options must select a connector.`)
      }

      const connectorName = (options as { connector?: string }).connector || definition.defaultConnector
      if (!connectorName) {
        throw channelError(`Channel "${name}" requires a connector in send options.`)
      }

      const connector = definition.connectors[connectorName]
      if (!connector) {
        throw channelError(`Channel "${name}" does not define connector "${connectorName}".`)
      }

      const connectorOptions = { ...(options as Record<string, unknown>) }
      delete connectorOptions.connector
      const deliveryId = globalThis.crypto.randomUUID()
      logDelivery("outbound.started", deliveryId, name, connectorName)
      try {
        const result = await connector.send(text, connectorOptions as never)
        if (!result || typeof result !== "object") {
          throw channelError(`Channel connector "${connectorName}" returned an invalid result.`)
        }
        logDelivery("outbound.completed", deliveryId, name, connectorName, { messageId: result.id })
        return {
          ...result,
          channel: name,
          connector: connectorName,
          deliveryId,
        }
      }
      catch (error) {
        logDelivery("outbound.failed", deliveryId, name, connectorName, { error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000) })
        throw error
      }
    },
  }
}
