import { expect, it } from "vitest"

import { uiErrorDiagnostics } from "../src/error-diagnostics.ts"
import { decodePlaygroundLink, zipFiles } from "../src/playground.ts"

it.each([
  uiErrorDiagnostics.UI_CLIPBOARD_UNAVAILABLE(),
  uiErrorDiagnostics.UI_MARKDOWN_UPLOAD_URL_MISSING({ route: "/api/upload", file: "photo.png" }),
  uiErrorDiagnostics.UI_ZIP_PATH_UNSAFE(),
])("gives $code a fix and its own docs page", (error) => {
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/ui/diagnostics/${error.code.toLowerCase()}`)
})

it("reports a ZIP file path outside the project with its code and fix", () => {
  expect(() => zipFiles({ "../secret.txt": "x" }, "starter")).toThrow(expect.objectContaining({
    code: "UI_ZIP_PATH_UNSAFE",
    fix: expect.stringContaining("`zipFiles()`"),
  }))
})

it("reads a share code that inflates above the limit as no files", async () => {
  const text = JSON.stringify({ f: { "a.txt": "x".repeat(4 * 1024 * 1024) } })
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const code = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  await expect(decodePlaygroundLink(code)).resolves.toBeUndefined()
})
