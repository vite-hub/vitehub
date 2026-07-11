import { createServer } from "node:http"

import { runAgent } from "@vite-hub/agent"
import { H3, readBody } from "h3"
import { toNodeHandler } from "h3/node"
import greeting from "../server/agents/greeting"
import { createMemo } from "./memo"

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

const port = Number(process.env.PORT || 5173)

createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`ViteHub Agents tutorial listening on http://localhost:${port}`)
})
