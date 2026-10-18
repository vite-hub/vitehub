import { H3 } from "h3"
import { readRequestPayload, runSandboxTask } from "@vite-hub/sandbox-task"
import type { ReleaseNotesPayload } from "./release-notes.sandbox-task"

const app = new H3()

app.post("/api/release-notes", async (event) => {
  // SAFETY: This route supplies a complete ReleaseNotesPayload fallback when request JSON cannot be read.
  const payload = await readRequestPayload(event, { notes: "" }) as ReleaseNotesPayload
  const response = await runSandboxTask("release-notes", payload)
  if (!response.ok)
    return response

  return { result: await response.json() }
})

export default app
