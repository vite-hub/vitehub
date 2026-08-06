import type { ChannelConnectorMap, ChannelDefinition } from "./types.ts"

function isConnector(value: unknown): value is { send: unknown } {
  return Boolean(value) && typeof value === "object" && typeof (value as { send?: unknown }).send === "function"
}

function validateChannelDefinition(value: unknown): asserts value is ChannelDefinition {
  const definition = value as ChannelDefinition
  if (!definition || typeof definition !== "object") {
    throw new TypeError("`defineChannel()` expects an object with connectors.")
  }

  if (!definition.connectors || typeof definition.connectors !== "object" || Array.isArray(definition.connectors)) {
    throw new TypeError("`defineChannel()` expects a connectors object.")
  }

  const connectorNames = Object.keys(definition.connectors)
  if (connectorNames.length === 0) {
    throw new TypeError("`defineChannel()` requires at least one connector.")
  }

  for (const name of connectorNames) {
    if (!isConnector(definition.connectors[name])) {
      throw new TypeError(`Channel connector "${name}" must expose a send function.`)
    }
  }

  if (definition.defaultConnector !== undefined && !connectorNames.includes(definition.defaultConnector)) {
    throw new TypeError(`Channel default connector "${definition.defaultConnector}" is not configured.`)
  }
}

export function defineChannel<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
>(
  definition: ChannelDefinition<TConnectors, TDefault>,
): ChannelDefinition<TConnectors, TDefault> {
  validateChannelDefinition(definition)
  return definition
}
