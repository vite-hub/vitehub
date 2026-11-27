import { runAgent } from "vite-hub/agent"
import { defineQueue } from "vite-hub/queue"

import translator from "../agents/translator"
import { content } from "../content"

export default defineQueue<{ id: string }>({
  handler: async ({ payload }) => {
    const english = await content.collection("docs").get(payload.id, { ref: "draft" })
    if (!english?.source) return
    const prompt = `Translate the docs page with id "${payload.id}" into Spanish. The source digest of the English version to translate is ${english.source.digest}.`
    const [error] = await runAgent(translator, { prompt })
    if (error) throw error
  },
})
