import { describe, expect, it, vi } from "vitest"

import { createWritableWorkspaceFs } from "@vite-hub/shell/workspace"
import { defineWorkspace, useWorkspace } from "../src/index.ts"
import { registerWorkspace } from "../src/test.ts"

describe("Workspace Shell filesystem", () => {
  it.each(["/workspace", "/workspace/", "/"])("preserves the Workspace root when moved to %s", async (destination) => {
    const name = `shell-root-move-${destination}`
    registerWorkspace(name, defineWorkspace({ store: { provider: "memory" } }))
    const workspace = useWorkspace(name, { mode: "write" })
    await workspace.fs.writeFile("notes.md", "saved content")
    const writeFile = vi.spyOn(workspace.fs, "writeFile")
    const rm = vi.spyOn(workspace.fs, "rm")
    const shellWorkspace = {
      ...workspace.fs,
      async writeFile(path: string, content: string | Uint8Array) { await workspace.fs.writeFile(path, content) },
    }

    await createWritableWorkspaceFs(shellWorkspace).mv("/workspace", destination)

    expect(writeFile).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
    await expect(workspace.fs.readFile("notes.md")).resolves.toBe("saved content")
  })
})
