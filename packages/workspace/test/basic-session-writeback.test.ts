import { describe, expect, it } from "vitest"

import { defineWorkspace } from "../src/core/define.ts"
import { createWorkspace } from "../src/core/workspace.ts"

import type { WorkspaceSessionOptions } from "../src/core/types.ts"

describe("basic session write-back policy", () => {
  it.each(["diff", "commit"] as const)("disables %s when writeBack is false", async (operation) => {
    const workspace = createWorkspace({
      ...defineWorkspace({ store: { provider: "memory" } }),
      name: "docs",
    })
    await workspace.writeFile("README.md", "authoritative")
    await workspace.snapshot()
    const session = await workspace.startSession({ writeBack: false })

    await session.writeFile("README.md", "private edit")
    await expect(session.readFile("README.md")).resolves.toBe("private edit")
    await expect(session[operation]()).rejects.toThrow(`${operation} is unavailable when writeBack is false`)
    await session.close()

    await expect(workspace.readFile("README.md")).resolves.toBe("authoritative")
  })

  it("keeps writeBack disabled if the caller mutates session options", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({ store: { provider: "memory" } }),
      name: "docs",
    })
    await workspace.writeFile("README.md", "authoritative")
    await workspace.snapshot()
    const options: WorkspaceSessionOptions = { writeBack: false }
    const session = await workspace.startSession(options)

    delete options.writeBack
    await session.writeFile("README.md", "private edit")
    await expect(session.diff()).rejects.toThrow("diff is unavailable when writeBack is false")
    await expect(session.commit()).rejects.toThrow("commit is unavailable when writeBack is false")
    await session.close()
    await expect(workspace.readFile("README.md")).resolves.toBe("authoritative")
  })
})
