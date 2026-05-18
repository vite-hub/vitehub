import { defineAgent, type AgentToolDefinition } from "@vitehub/agent"
import { createDevtoolsAdapter } from "@vitehub/chat/devtools"
import { createMemoryChatStateAdapter } from "@vitehub/chat/runtime/memory-state"
import { getMessageText } from "@vitehub/messages"

type Queue = "billing" | "incident" | "product"

const classifyMessage: AgentToolDefinition<{ message: string }, { queue: Queue, priority: "normal" | "urgent", summary: string }> = {
  name: "classifyMessage",
  description: "Classify an incoming chat message before queue handoff.",
  execute: ({ message }) => {
    const queue: Queue = /down|broken|500|urgent/i.test(message)
      ? "incident"
      : /refund|invoice|payment/i.test(message)
        ? "billing"
        : "product"

    return {
      queue,
      priority: queue === "incident" ? "urgent" : "normal",
      summary: message.slice(0, 140),
    }
  },
}

export default defineAgent({
  chat: {
    adapters: {
      devtools: createDevtoolsAdapter(),
    },
    state: createMemoryChatStateAdapter(),
  },
  description: "Triage support chat messages and prepare a queue handoff.",
  async run({ input }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ""
    const ticket = await classifyMessage.execute?.({
      message: message || "Empty support request.",
    })

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority: ${ticket.summary}`
        : "Unable to classify the support request.",
    }
  },
})
