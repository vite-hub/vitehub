import { H3, readBody } from "h3"

import { runAgent } from "@vite-hub/agent"
import greeting from "../server/agents/greeting"

function createMemo() {
  const values = new Map<string, unknown>()

  return <T>(key: string, create: () => T): T => {
    if (!values.has(key)) values.set(key, create())
    // SAFETY: values for each memo key are created and read through this generic callback contract.
    return values.get(key) as T
  }
}

const app = new H3().post("/greet", async (event) => {
  const body = await readBody<{ name?: string }>(event) || {}

  return await runAgent(greeting, {
    memo: createMemo(),
    runtime: "vite",
    waitUntil: task => { void task.catch(error => console.error(error)) },
  }, {
    prompt: body.name?.trim() || "friend",
  })
})

export default app
