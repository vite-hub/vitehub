import { createError, H3 } from "h3"
import { readRequestPayload, runSandbox } from "@vite-hub/sandbox"
import type { ReleaseNotesPayload } from "./release-notes.sandbox"

const app = new H3()

app.post("/api/release-notes", async (event) => {
  const payload = await readRequestPayload<ReleaseNotesPayload>(event, { notes: "" }) as ReleaseNotesPayload
  const [error, result] = await runSandbox("release-notes", payload)

  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }

  return { result }
})

export default app
