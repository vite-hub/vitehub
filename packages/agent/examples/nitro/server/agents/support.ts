import { defineAgent, defineTool } from "@vitehub/agent"
import { getMessageText } from "@vitehub/messages"

type Queue = "billing" | "incident" | "product"

const classifyTicket = defineTool<{ message: string }, { queue: Queue, priority: "normal" | "urgent", summary: string }>({
  name: "classifyTicket",
  description: "Classify a support request before it is handed to a queue.",
  policy: ({ input }) => {
    const message = typeof input === "object" && input && "message" in input
      ? String(input.message)
      : ""

    return /refund|invoice|payment/i.test(message) ? "require-approval" : "allow"
  },
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
})

export default defineAgent({
  description: "Triage support requests and prepare a queue handoff.",
  async run({ input, waitUntil }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ""
    const ticket = await classifyTicket.execute?.({
      message: message || "Empty support request.",
    })

    waitUntil?.(Promise.resolve({
      event: "support.triaged",
      ticket,
    }))

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority: ${ticket.summary}`
        : "Unable to classify the support request.",
    }
  },
})
