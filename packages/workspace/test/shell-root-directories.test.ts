import { describe, expect, it, vi } from "vitest"

import { createShellRuntime } from "@vite-hub/shell"
import { createJustBashProvider } from "@vite-hub/shell/providers/just-bash"
import { createReadonlyWorkspaceFs, createWritableWorkspaceFs } from "@vite-hub/shell/workspace"
import { defineWorkspace, useWorkspace } from "../src/index.ts"
import { registerWorkspace } from "../src/test.ts"

describe("Workspace Shell root directories", () => {
  it.each(["/workspace", "/workspace/", "/"])("recognizes and preserves the virtual root at %s", async (path) => {
    const name = `shell-root-directory-${path}`
    registerWorkspace(name, defineWorkspace({ store: { provider: "memory" } }))
    const workspace = useWorkspace(name, { mode: "write" })
    await workspace.fs.writeFile("notes.md", "saved content")
    const exists = vi.spyOn(workspace.fs, "exists")
    const mkdir = vi.spyOn(workspace.fs, "mkdir")
    const shellWorkspace = {
      ...workspace.fs,
      async writeFile(filePath: string, content: string | Uint8Array) { await workspace.fs.writeFile(filePath, content) },
    }
    const fs = createWritableWorkspaceFs(shellWorkspace)

    await expect(fs.exists(path)).resolves.toBe(true)
    await expect(fs.stat(path)).resolves.toMatchObject({ isDirectory: true, isFile: false })
    await expect(createReadonlyWorkspaceFs(workspace.fs).exists(path)).resolves.toBe(true)
    await fs.mkdir(path, { recursive: true })
    await expect(fs.mkdir(path)).rejects.toThrow("already exists")
    const runtime = createShellRuntime({ provider: createJustBashProvider({ commands: ["mkdir"], cwd: "/workspace", fs }) })
    await expect(runtime.exec(`mkdir -p ${path}`)).resolves.toMatchObject({ exitCode: 0, stderr: "" })

    expect(exists).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    await expect(workspace.fs.readFile("notes.md")).resolves.toBe("saved content")
  })
})
