import { createChannel, defineChannel } from "../src/index.ts"

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

// @ts-expect-error Connector options remain specific to the selected connector.
channel.send("Build finished.", { connector: "telegram", channelId: "channel-1" })
