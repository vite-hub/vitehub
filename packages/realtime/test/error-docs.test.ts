import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"

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

it.each([
  { why: undefined, expectedWhy: "The stored document changed since the realtime room loaded it." },
  { why: "The Workspace changed.", expectedWhy: "The Workspace changed." },
])("keeps the document conflict code and public fields through JSON ($why)", ({ why, expectedWhy }) => {
  const conflict = new RealtimeDocumentConflict(why)
  Object.assign(conflict, {
    cause: { token: "private-adapter-token" },
    data: { private: "private-adapter-data" },
    sources: ["/private/adapter.ts:1:1"],
  })

  expect(conflict).toMatchObject({
    code: "REALTIME_DOCUMENT_CONFLICT",
    docs: "https://vitehub.dev/docs/realtime/limits-and-errors#realtime_document_conflict",
    name: "RealtimeDocumentConflict",
    why: expectedWhy,
  })
  expect(isRealtimeDocumentConflict(conflict)).toBe(true)
  const serialized: unknown = JSON.parse(JSON.stringify(conflict))
  expect(serialized).toEqual({
    code: "REALTIME_DOCUMENT_CONFLICT",
    docs: "https://vitehub.dev/docs/realtime/limits-and-errors#realtime_document_conflict",
    fix: "Realtime re-seeds the room from the stored document. Listen to `onReset()` to recover text that the room did not save.",
    name: "RealtimeDocumentConflict",
    why: expectedWhy,
  })
  expect(normalizeRuntimeDiagnosticError(serialized)?.code).toBe("REALTIME_DOCUMENT_CONFLICT")
  expect(isRealtimeDocumentConflict(serialized)).toBe(true)
  expect(isRealtimeDocumentConflict({ name: "RealtimeDocumentConflict" })).toBe(false)
  expect(isRealtimeDocumentConflict({ code: "REALTIME_SOURCE_CHANGED" })).toBe(false)
})
