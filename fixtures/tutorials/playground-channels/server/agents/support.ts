import { defineAgent } from "vite-hub/agent"
import { discord, slack, teams, telegram } from "vite-hub/agent/channels"

export default defineAgent({
  runtime: false,
  channels: {
    slack: slack(),
    discord: discord(),
    teams: teams(),
    telegram: telegram(),
  },
  driver: {
    run({ messages }) {
      const parts = messages.filter(message => message.role === "user").at(-1)?.parts ?? []
      const text = parts.map(part => part.type === "text" ? part.text : "").join("").trim()

      return {
        text: `You said "${text}". This reply came from the support Agent.`,
      }
    },
  },
})
