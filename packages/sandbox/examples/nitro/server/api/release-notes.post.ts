import { readRequestPayload, runSandbox } from "@vitehub/sandbox"
import type { ReleaseNotesPayload } from "../sandboxes/release-notes"

export default defineEventHandler(async (event) => {
  const payload = await readRequestPayload<ReleaseNotesPayload>(event, { notes: "" }) as ReleaseNotesPayload
  const result = await runSandbox("release-notes", payload)

  if (result.isErr()) {
    throw createError({ statusCode: 500, statusMessage: result.error.message })
  }

  return { result: result.value }
})
