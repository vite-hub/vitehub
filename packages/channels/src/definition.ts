import type { ChannelConnectorMap, ChannelDefinition } from "./types.ts"
import { channelsErrorDiagnostics } from "./error-diagnostics.ts"

function isConnector(value: unknown): value is { send: unknown } {
  try {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connector configuration is an opaque input; reject primitives before reading its send member.
    if (value === null || typeof value !== "object") return false
    // SAFETY: The object guard permits reading the optional send member, whose callable representation is checked below.
    const connector = value as { send?: unknown }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The connector contract requires a callable send member; getter failures are handled by this boundary.
    return typeof connector.send === "function"
  }
  catch {
    return false
  }
}

function formatDiagnosticValue(value: unknown): string {
  try {
    return String(value)
  }
  catch {
    return "<unrepresentable>"
  }
}

function validateChannelDefinition(value: unknown): asserts value is ChannelDefinition {
  const definition = value as ChannelDefinition
  if (!definition || typeof definition !== "object") {
    throw channelsErrorDiagnostics.CHANNELS_C0001({ message: "`defineOutboundChannel()` expects an object with connectors." })
  }

  let connectors: ChannelDefinition["connectors"]
  try {
    connectors = definition.connectors
  }
  catch {
    throw channelsErrorDiagnostics.CHANNELS_C0002({ message: "`defineOutboundChannel()` expects a connectors object." })
  }

  let validConnectors = false
  try {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Connector configuration is an opaque input; reject primitives before enumerating it.
    validConnectors = Boolean(connectors) && typeof connectors === "object" && !Array.isArray(connectors)
  }
  catch {
    validConnectors = false
  }
  if (!validConnectors) {
    throw channelsErrorDiagnostics.CHANNELS_C0002({ message: "`defineOutboundChannel()` expects a connectors object." })
  }

  let connectorNames: string[]
  try {
    connectorNames = Object.keys(connectors)
  }
  catch {
    throw channelsErrorDiagnostics.CHANNELS_C0002({ message: "`defineOutboundChannel()` expects a connectors object." })
  }
  if (connectorNames.length === 0) {
    throw channelsErrorDiagnostics.CHANNELS_C0003({ message: "`defineOutboundChannel()` requires at least one connector." })
  }

  for (const name of connectorNames) {
    if (!name) {
      throw channelsErrorDiagnostics.CHANNELS_C0006({ message: "Channel connector names must be non-empty." })
    }
    let connector: unknown
    try {
      connector = connectors[name]
    }
    catch {
      connector = undefined
    }
    if (!isConnector(connector)) {
      throw channelsErrorDiagnostics.CHANNELS_C0004({ message: `Channel connector "${name}" must expose a send function.` })
    }
  }

  let defaultConnector: ChannelDefinition["defaultConnector"]
  try {
    defaultConnector = definition.defaultConnector
  }
  catch {
    throw channelsErrorDiagnostics.CHANNELS_C0005({ message: "Channel default connector could not be read." })
  }
  if (defaultConnector !== undefined && !connectorNames.includes(defaultConnector)) {
    throw channelsErrorDiagnostics.CHANNELS_C0005({ message: `Channel default connector "${formatDiagnosticValue(defaultConnector)}" is not configured.` })
  }
}

/**
 * Defines an outbound Channel: a named destination that sends text through one of its connectors.
 * Agent Channel Kinds use `defineChannel()` from `@vite-hub/agent/channels` instead.
 */
export function defineOutboundChannel<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
>(
  definition: ChannelDefinition<TConnectors, TDefault>,
): ChannelDefinition<TConnectors, TDefault> {
  validateChannelDefinition(definition)
  return definition
}

/**
 * @deprecated Use `defineOutboundChannel()`. This alias will be removed in the next release.
 */
export const defineChannel: typeof defineOutboundChannel = defineOutboundChannel
