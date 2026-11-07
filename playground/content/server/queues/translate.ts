import { runAgent } from "vite-hub/agent"
import { defineQueue } from "vite-hub/queue"

import translator from "../agents/translator"

// `server/workspaces/site.ts` enqueues this job when an English docs page changes on the draft.
export default defineQueue<{ id: string }>(async ({ payload }) => {
  const [error] = await runAgent(translator, { prompt: `Translate the docs page with id "${payload.id}" into Spanish.` }, { output: "drained" })
  if (error) throw error
})
