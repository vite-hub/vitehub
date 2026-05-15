import { defineAgent } from "@vitehub/agent"

export default defineAgent({
  description: "Triage playground chat messages",
  instructions: "Summarize the incoming chat context and suggest the next action.",
  async run({ input }) {
    const latest = input.messages?.at(-1)
    const content = typeof latest?.content === "string"
      ? latest.content
      : JSON.stringify(latest?.content || "")

    return (async function* () {
      yield "Triage\n\n"
      yield `Message: ${content || "No message text"}\n`
      yield "Next action: acknowledge the request and route it to the right owner."
    })()
  },
})
