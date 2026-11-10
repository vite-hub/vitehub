import { afterEach, describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"

import { defineWorkspace, useWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(() => {
  resetWorkspaceRegistry()
})

describe("workspace file responses", () => {
  it("returns not found for a directory path", async () => {
    registerWorkspace("directory-response", defineWorkspace({ store: { provider: "memory" } }))
    const workspace = useWorkspace("directory-response", { mode: "write" })
    await workspace.fs.mkdir("docs")

    const { readWorkspaceFileResponse } = await import("../src/server.ts")
    const response = await readWorkspaceFileResponse({
      path: "docs",
      workspace: "directory-response",
    })
    expect(response.status).toBe(404)
  })

  it("maps a cross-realm missing-file error to not found", async () => {
    const missing = runInNewContext("new Error('Workspace file does not exist: docs/missing.txt')") as Error
    const workspace = {
      fs: {
        readFile: async () => { throw missing },
        stat: async () => ({ path: "docs/missing.txt", type: "file" as const }),
      },
    }

    const { readWorkspaceFileResponse } = await import("../src/server.ts")
    const response = await readWorkspaceFileResponse({
      path: "docs/missing.txt",
      workspace: workspace as never,
    })
    expect(response.status).toBe(404)
  })
})
