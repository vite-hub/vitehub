import { createAgentMessage } from "@vitehub/agent"
import { runAgent } from "@vitehub/agent"
import supportAgent from "../agents/support"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ message?: string }>(event)

  return await runAgent(supportAgent, { runtime: "nitro" }, {
    messages: [
      createAgentMessage({
        role: "user",
        text: body.message || "How should I route this request?",
      }),
    ],
  })
})
