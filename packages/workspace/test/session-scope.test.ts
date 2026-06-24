import { describe, expect, it } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { defineWorkspace } from "../src/index.ts"

describe("workspace session scope", () => {
  it("enforces scoped basic session reads, lists, searches, writes, and commits", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({ store: { provider: "memory" } }),
      name: "docs",
    })
    await workspace.writeFile("public/README.md", "needle public\n")
    await workspace.writeFile("private/README.md", "needle private\n")
    await workspace.snapshot({ name: "baseline" })

    const session = await workspace.startSession({ paths: ["public"] })

    await expect(session.readFile("public/README.md")).resolves.toBe("needle public\n")
    await expect(session.readFile("private/README.md")).rejects.toThrow("does not exist")
    expect((await session.list("", { recursive: true })).map(entry => entry.path)).toEqual([
      "public",
      "public/README.md",
    ])
    expect((await session.glob("**/*.md")).map(entry => entry.path)).toEqual(["public/README.md"])
    expect((await session.search({ cwd: ".", pattern: "needle" })).map(hit => hit.path)).toEqual(["public/README.md"])
    await expect(session.writeFile("private/new.md", "nope")).rejects.toThrow("outside the session scope")

    await session.writeFile("public/new.md", "ok")
    await workspace.writeFile("private/pending.md", "direct change")
    expect((await session.diff()).entries.map(entry => entry.path)).toEqual(["public/new.md"])
    await expect(session.commit()).rejects.toThrow("outside the session scope")
  })

  it("allows scoped file sessions to create missing parent directories", async () => {
    const workspace = createWorkspace({
      ...defineWorkspace({ store: { provider: "memory" } }),
      name: "docs",
    })
    await workspace.snapshot({ name: "baseline" })

    const session = await workspace.startSession({ paths: ["reports/out.txt"] })
    await session.writeFile("reports/out.txt", "ok")

    expect((await session.diff()).entries.map(entry => entry.path)).toEqual(["reports", "reports/out.txt"])
    await session.commit()
    await expect(workspace.readFile("reports/out.txt")).resolves.toBe("ok")
  })
})
