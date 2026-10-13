import { createChannel, defineOutboundChannel, useChannel } from "../src/index.ts"

interface NamedConnectorOptions {
  destination: string
}

interface DynamicConnectorOptions extends NamedConnectorOptions {
  connector: string
}

class ConstructorOptions {}

declare global {
  interface ViteHubChannelDefinitionModules {
    alerts: { default: typeof definition }
  }
}

const definition = defineOutboundChannel({
  connectors: {
    slack: {
      send: async (_text: string, options: { channelId: string, threadTs?: string }) => ({ id: options.channelId }),
    },
    telegram: {
      send: async (_text: string, options: { chatId: string }) => ({ id: options.chatId }),
    },
  },
})

const channel = createChannel("alerts", definition)

const namedInterfaceChannel = createChannel("named-interface", defineOutboundChannel({
  connectors: {
    webhook: {
      send: async (_text: string, options: NamedConnectorOptions) => ({ id: options.destination }),
    },
  },
}))

namedInterfaceChannel.send("Build finished.", { connector: "webhook", destination: "endpoint-1" })

const optionalOptionsChannel = createChannel("optional-options", defineOutboundChannel({
  connectors: {
    webhook: {
      send: async (_text: string, options?: NamedConnectorOptions) => ({ id: options?.destination }),
    },
  },
}))
optionalOptionsChannel.send("Build finished.", { connector: "webhook", destination: "endpoint-1" })
// @ts-expect-error Supplied options still need the connector's required properties.
optionalOptionsChannel.send("Build finished.", { connector: "webhook" })
// @ts-expect-error Optional parameters must retain known-connector excess-property checks.
optionalOptionsChannel.send("Build finished.", { connector: "webhook", destination: "endpoint-1", destinaton: "typo" })

const metadataChannel = createChannel("metadata-only", defineOutboundChannel({
  connectors: {
    webhook: {
      send: async () => ({ status: "accepted" }),
    },
  },
}))

metadataChannel.send("Build finished.", { connector: "webhook" })

defineOutboundChannel({
  connectors: {
    pingOnly: {
      // @ts-expect-error Connectors must accept every string exposed by Channel.send().
      send: (_text: "ping", _options: NamedConnectorOptions) => ({ status: "accepted" }),
    },
  },
})

defineOutboundChannel({
  connectors: {
    // @ts-expect-error Connector options must be objects because send passes an options object.
    primitiveOptions: {
      send: (_text: string, _options: string) => ({ status: "accepted" }),
    },
  },
})

defineOutboundChannel({
  connectors: {
    // @ts-expect-error Connector options must be non-callable objects accepted by runtime dispatch.
    callableOptions: {
      send: (_text: string, _options: () => void) => ({ status: "accepted" }),
    },
    // @ts-expect-error Constructor functions are also rejected by runtime dispatch.
    constructorOptions: {
      send: (_text: string, _options: typeof ConstructorOptions) => ({ status: "accepted" }),
    },
  },
})

defineOutboundChannel({
  connectors: {
    // @ts-expect-error Callable receipts are rejected by runtime dispatch after delivery.
    callableResult: { send: (_text: string) => () => {} },
    // @ts-expect-error Async callable receipts must also be rejected statically.
    asyncCallableResult: { send: async (_text: string) => () => {} },
    // @ts-expect-error Constructor-function receipts are rejected by runtime dispatch.
    constructorResult: { send: (_text: string) => ConstructorOptions },
    // @ts-expect-error Unions containing callable receipts cannot guarantee an object receipt.
    unionResult: { send: (_text: string): { id: string } | (() => void) => ({ id: "accepted" }) },
    // @ts-expect-error Broad standard function annotations are still callable receipts.
    functionResult: { send: (_text: string): Function => () => {} },
    // @ts-expect-error CallableFunction annotations are rejected like concrete functions.
    broadCallableResult: { send: async (_text: string): Promise<CallableFunction> => () => {} },
    // @ts-expect-error NewableFunction annotations are rejected like concrete constructors.
    broadConstructorResult: { send: (_text: string): NewableFunction => ConstructorOptions },
  },
})

const dynamicCallableConnectors: Record<string, { send: (text: string) => () => void }> = {
  webhook: { send: (_text: string) => () => {} },
}
// @ts-expect-error Dynamic maps must reject statically known callable receipts.
defineOutboundChannel({ connectors: dynamicCallableConnectors })

async function checkSendTuple() {
  const [error, receipt] = await channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })
  if (error) {
    const absent: null = receipt
    return absent
  }
  const noError: null = error
  const deliveryId: string = receipt.deliveryId
  return { noError, deliveryId }
}
void checkSendTuple

channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })
channel.send("Build finished.", { connector: "slack", channelId: "channel-1" })

// @ts-expect-error Known connectors reject misspelled option properties.
channel.send("Build finished.", { connector: "telegram", chatId: "chat-1", slient: true })

const defaultChannel = createChannel("defaults", defineOutboundChannel({
  connectors: definition.connectors,
  defaultConnector: "telegram",
}))
defaultChannel.send("Build finished.", { chatId: "chat-1" })

// @ts-expect-error Default connectors reject misspelled option properties.
defaultChannel.send("Build finished.", { chatId: "chat-1", slient: true })

// @ts-expect-error Connector options remain specific to the selected connector.
channel.send("Build finished.", { connector: "telegram", channelId: "channel-1" })

const discovered = useChannel("alerts")
discovered.send("Build finished.", { connector: "telegram", chatId: "chat-1" })

// @ts-expect-error Generated Channel names reject unknown literals.
useChannel("alrets")

const runtimeName: string = "runtime-channel"
const dynamic = useChannel(runtimeName)
dynamic.send("Build finished.", { connector: "runtime", destination: "room-1" })
dynamic.send("Build finished.", {})
const dynamicOptions: DynamicConnectorOptions = { connector: "runtime", destination: "room-1" }
dynamic.send("Build finished.", dynamicOptions)
const dynamicDefaultOptions: NamedConnectorOptions = { destination: "room-1" }
dynamic.send("Build finished.", dynamicDefaultOptions)
dynamic.send("Build finished.", { destination: "room-1" })

// @ts-expect-error Dynamic channel options cannot be callable.
dynamic.send("Build finished.", Object.assign(() => {}, { connector: "runtime" }))

// @ts-expect-error Dynamic channel options cannot be constructor functions.
dynamic.send("Build finished.", Object.assign(ConstructorOptions, { connector: "runtime" }))

// @ts-expect-error Dynamic connector selectors must be strings when present.
dynamic.send("Build finished.", { connector: 42 })

// @ts-expect-error Dynamic channel options must be objects.
dynamic.send("Build finished.", "room-1")

// @ts-expect-error Discovered Channel names retain connector-specific options.
discovered.send("Build finished.", { connector: "telegram", channelId: "channel-1" })
