import { H3, readBody } from "h3"
import { createMessage } from "@vite-hub/agent"
import { runAgent } from "@vite-hub/agent"
import supportAgent from "./support.agent"

const app = new H3()

app.post("/api/support", async (event) => {
  const body = await readBody<{ message?: string }>(event)

  return await runAgent(supportAgent, { runtime: "vite" }, {
    messages: [
      createMessage({
        role: "user",
        text: body.message || "How should I route this request?",
      }),
    ],
  })
})

export default app
