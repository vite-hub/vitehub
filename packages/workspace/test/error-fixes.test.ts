import { expect, it } from "vitest"

import { workspaceErrorDiagnostics } from "../src/error-diagnostics.ts"
import { readWorkspaceFileOwner, recordWorkspaceFileOwner, removeWorkspaceOwnedFile } from "../src/sources/file-ownership.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

// These published codes have no call site left.
const unused = new Set(["WORKSPACE_R0030", "WORKSPACE_R0062", "WORKSPACE_R0068"])

it("gives each raised Workspace code a fix and its own docs page", () => {
  for (const [code, create] of Object.entries(workspaceErrorDiagnostics)) {
    if (unused.has(code)) continue
    // SAFETY: Each code accepts its own params; the fix and docs do not depend on them.
    const error = (create as (params: Record<string, string>) => { docs?: string, fix?: string })({ message: "message", path: "items.json" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/workspace/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an interrupted removal without a file revision with a code and a fix", async () => {
  const store = createMemoryWorkspaceStore()
  const stat = store.stat.bind(store)
  store.stat = async (path) => {
    const entry = await stat(path)
    return entry && { ...entry, revision: undefined }
  }
  await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
  await recordWorkspaceFileOwner(store, "owned.md", { workspace: "outage", source: "source", digest: (await stat("owned.md"))?.digest })
  store.rm = async () => { throw new Error("remove unavailable") }
  await expect(removeWorkspaceOwnedFile(store, "owned.md")).rejects.toThrow("remove unavailable")
  await expect(readWorkspaceFileOwner(store, "owned.md", true)).rejects.toThrow(expect.objectContaining({
    code: "WORKSPACE_R0074",
    fix: expect.stringContaining("delete it in the Store itself"),
    message: expect.stringContaining("Cannot retry interrupted removal without a file revision: owned.md"),
  }))
})
