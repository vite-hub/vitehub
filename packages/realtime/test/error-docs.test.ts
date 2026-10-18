import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

import { RealtimeDocumentConflict, isRealtimeDocumentConflict } from "../src/conflict.ts"
import { realtimeErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents each Realtime error code with a why, a fix, and a docs heading", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/realtime/limits-and-errors.md", import.meta.url), "utf8")

  for (const code of Object.keys(realtimeErrorDiagnostics)) {
    expect(page, code).toContain(`\n### ${code}\n`)
  }
  const error = realtimeErrorDiagnostics.REALTIME_DISABLED({ action: "save" })
  expect(error.docs).toBe("https://vitehub.dev/docs/realtime/limits-and-errors#realtime_disabled")
  expect(error.why).toBe("Realtime is disabled, so `save()` cannot run.")
  expect(error.fix).not.toBe("")
})

it("keeps the document conflict class on the catalog code", () => {
  const conflict = new RealtimeDocumentConflict("The Workspace changed.")

  expect(conflict).toMatchObject({
    code: "REALTIME_DOCUMENT_CONFLICT",
    docs: "https://vitehub.dev/docs/realtime/limits-and-errors#realtime_document_conflict",
    name: "RealtimeDocumentConflict",
    why: "The Workspace changed.",
  })
  expect(isRealtimeDocumentConflict(conflict)).toBe(true)
  expect(new RealtimeDocumentConflict().why).toBe("The stored document changed since the realtime room loaded it.")
})
