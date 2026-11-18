import { afterEach, expect, it, vi } from "vitest"

import { webContainerErrorDiagnostics } from "../src/error-diagnostics.ts"
import { bootWebContainer } from "../src/index.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

it("gives the snapshot lockfile code a fix and its own docs page", () => {
  const error = webContainerErrorDiagnostics.WEB_CONTAINER_SNAPSHOT_LOCKFILE_MISMATCH({ wasm: true })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe("https://vitehub.dev/docs/web-container/diagnostics/web_container_snapshot_lockfile_mismatch")
})

it("rejects a page that is not cross-origin isolated with WEB_CONTAINER_UNSUPPORTED, its reason, and a fix", async () => {
  vi.stubGlobal("document", {})
  vi.stubGlobal("crossOriginIsolated", false)
  await expect(bootWebContainer()).rejects.toMatchObject({
    code: "WEB_CONTAINER_UNSUPPORTED",
    docs: "https://vitehub.dev/docs/web-container/diagnostics/web_container_unsupported",
    fix: expect.stringContaining("hubWebContainer"),
    message: expect.stringContaining("not cross-origin isolated"),
  })
})
