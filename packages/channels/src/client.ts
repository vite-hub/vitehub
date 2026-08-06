import { defineChannel, resolveChannelDefinition } from "./definition.ts"

import type {
  ChannelClient,
  ChannelConnectorMap,
  ChannelDefinitionInput,
  ChannelRuntimeEnv,
  ChannelSendOptions,
  ChannelSendResult,
} from "./types.ts"

function channelError(message: string): Error {
  return new Error(`[vitehub] ${message}`)
}

export function createChannel<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
>(
  name: string,
  definition: ChannelDefinitionInput<TConnectors, TDefault>,
  resolveEnv: () => ChannelRuntimeEnv = () => ({}),
): ChannelClient<TConnectors, TDefault> {
  if (typeof definition !== "function") defineChannel(definition)

  return {
    name,
    async send(text: string, options: ChannelSendOptions<TConnectors, TDefault>): Promise<ChannelSendResult> {
      if (typeof text !== "string" || text.trim().length === 0) {
        throw channelError("Channel message text must be a non-empty string.")
      }

      if (!options || typeof options !== "object") {
        throw channelError(`Channel "${name}" send options must select a connector.`)
      }

      const resolvedDefinition = resolveChannelDefinition(definition, resolveEnv())
      const connectorName = (options as { connector?: string }).connector || resolvedDefinition.defaultConnector
      if (!connectorName) {
        throw channelError(`Channel "${name}" requires a connector in send options.`)
      }

      const connector = resolvedDefinition.connectors[connectorName]
      if (!connector) {
        throw channelError(`Channel "${name}" does not define connector "${connectorName}".`)
      }

      const connectorOptions = { ...(options as Record<string, unknown>) }
      delete connectorOptions.connector
      const result = await connector.send(text, connectorOptions as never)
      if (!result || typeof result !== "object") {
        throw channelError(`Channel connector "${connectorName}" returned an invalid result.`)
      }

      return {
        ...result,
        channel: name,
        connector: connectorName,
      }
    },
  }
}
