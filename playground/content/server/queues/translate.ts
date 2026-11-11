import { runAgent } from "vite-hub/agent"
import { defineQueue } from "vite-hub/queue"

import translator from "../agents/translator"
import { content } from "../content"

// `server/workspaces/site.ts` enqueues this job when an English docs page changes on the draft. The job binds to the
// English version on the draft when it starts. A later change enqueues its own job, so this one stops if the page moves.
export default defineQueue<{ id: string }>(async ({ payload }) => {
  const english = await content.collection("docs").get(payload.id, { ref: "draft" })
  // The English page was deleted since the change: nothing to translate.
  if (!english?.source) return
  const prompt = `Translate the docs page with id "${payload.id}" into Spanish. The source digest of the English version to translate is ${english.source.digest}.`
  const [error] = await runAgent(translator, { prompt })
  if (error) throw error
})
