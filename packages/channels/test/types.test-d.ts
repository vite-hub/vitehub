import { createChannel, defineChannel, useChannel } from "../src/index.ts"

declare global {
  interface ViteHubChannelDefinitionModules {
    alerts: { default: typeof definition }
    envAlerts: { default: typeof envDefinition }
  }
}

const definition = defineChannel({
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

channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })
channel.send("Build finished.", { connector: "slack", channelId: "channel-1" })

const envDefinition = defineChannel(({ env }) => ({
  connectors: {
    telegram: {
      send: async (_text: string, options: { chatId: string }) => ({ id: `${env.telegramToken}:${options.chatId}` }),
    },
  },
}))

createChannel("alerts", envDefinition).send("Build finished.", { connector: "telegram", chatId: "chat-1" })

useChannel("envAlerts").send("Build finished.", { connector: "telegram", chatId: "chat-1" })

// @ts-expect-error Resolver-backed discovered Channels retain connector-specific options.
useChannel("envAlerts").send("Build finished.", { connector: "telegram", channelId: "channel-1" })

// @ts-expect-error Connector options remain specific to the selected connector.
channel.send("Build finished.", { connector: "telegram", channelId: "channel-1" })

const discovered = useChannel("alerts")
discovered.send("Build finished.", { connector: "telegram", chatId: "chat-1" })

// @ts-expect-error Discovered Channel names retain connector-specific options.
discovered.send("Build finished.", { connector: "telegram", channelId: "channel-1" })
