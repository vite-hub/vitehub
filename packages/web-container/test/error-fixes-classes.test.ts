import { afterEach, expect, it, vi } from "vitest"

import { webContainerBrowserDiagnostics } from "../src/browser-diagnostics.ts"
import { webContainerErrorDiagnostics } from "../src/error-diagnostics.ts"
import { bootWebContainer } from "../src/index.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

it("gives the codes that replaced the WebContainer error classes a fix and their own docs page", () => {
  for (const error of [webContainerBrowserDiagnostics.WEB_CONTAINER_UNSUPPORTED({ reason: "r" }), webContainerErrorDiagnostics.WEB_CONTAINER_SNAPSHOT_LOCKFILE_MISMATCH({ wasm: true })]) {
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/web-container/diagnostics/${error.code.toLowerCase()}`)
  }
})

it("rejects a page that is not cross-origin isolated with WEB_CONTAINER_UNSUPPORTED and its reason", async () => {
  vi.stubGlobal("document", {})
  vi.stubGlobal("crossOriginIsolated", false)
  await expect(bootWebContainer()).rejects.toMatchObject({
    code: "WEB_CONTAINER_UNSUPPORTED",
    fix: expect.stringContaining("hubWebContainer"),
    message: expect.stringContaining("not cross-origin isolated"),
  })
})
