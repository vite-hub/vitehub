import { createChannel, defineChannel, useChannel } from "../src/index.ts"

const definition = defineChannel({
  connectors: {
    slack: {
      send: async (_text: string, recipient: string, options: { threadTs?: string }) => ({ id: `${recipient}:${options.threadTs || ""}` }),
    },
    telegram: {
      send: async (_text: string, recipient: string, options: { format?: string }) => ({ id: `${recipient}:${options.format || ""}` }),
    },
  },
})

const channel = createChannel("alerts", definition)
channel.send("Build finished.", "chat-1", { connector: "telegram", format: "markdown" })
channel.send("Build finished.", "channel-1", { connector: "slack", threadTs: "1" })

// @ts-expect-error Connector options remain specific to the selected connector.
channel.send("Build finished.", "chat-1", { connector: "telegram", threadTs: "1" })

const global = useChannel("teams")
global.send("Build finished.", "user:123")
