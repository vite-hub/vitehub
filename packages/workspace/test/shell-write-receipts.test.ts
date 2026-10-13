import { createWritableWorkspaceFs, workspaceMountPoint } from "@vite-hub/shell/workspace"
import { afterEach, describe, expect, it } from "vitest"

import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { defineWorkspace, useWorkspace } from "../src/index.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(() => {
  resetWorkspaceRegistry()
})

describe("Shell Workspace write receipts", () => {
  it("accepts the writable public facade and ignores its revision receipts", async () => {
    registerWorkspace("shell-write-receipts", defineWorkspace({ store: { provider: "memory" } }))
    const workspace = useWorkspace("shell-write-receipts", { mode: "write" })
    const fs = createWritableWorkspaceFs(workspace.fs)

    await expect(workspace.fs.writeFile("receipt.txt", "direct")).resolves.toEqual(expect.any(String))
    await expect(fs.writeFile(`${workspaceMountPoint}/receipt.txt`, "shell")).resolves.toBeUndefined()
    await expect(fs.appendFile(`${workspaceMountPoint}/receipt.txt`, " append")).resolves.toBeUndefined()
    await expect(workspace.fs.readFile("receipt.txt")).resolves.toBe("shell append")
  })
})
