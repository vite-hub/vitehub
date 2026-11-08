import { H3, readBody } from "h3"

import { runAgent } from "@vite-hub/agent"
import greeting from "../server/agents/greeting"

const app = new H3().post("/greet", async (event) => {
  const body = await readBody<{ name?: string }>(event) || {}

  const [error, result] = await runAgent(greeting, {
    prompt: body.name?.trim() || "friend",
  }, {
    runtimeContext: {
      runtime: "vite",
      waitUntil: task => { void task.catch(error => console.error(error)) },
    },
  })
  if (error) throw error
  return { text: result.text }
})

export default app
