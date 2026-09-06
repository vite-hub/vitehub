import { createSource } from "@vite-hub/source"
import { file } from "@vite-hub/source/file"
import { describe, expect, it } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { defineWorkspace } from "../src/index.ts"

describe("standalone Source definitions", () => {
  it("reuses a file definition for direct reads and a protected Workspace mount", async () => {
    const guide = file({ workspacePath: "intro.md", content: "# Introduction\n" })
    const workspace = createWorkspace({
      ...defineWorkspace({
        store: { provider: "memory" },
        sources: {
          guide: { source: guide, mount: "docs", materialize: "lazy" },
        },
      }),
      name: "direct-source",
    })

    await expect(createSource(guide).read("intro.md")).resolves.toBe("# Introduction\n")
    await expect(workspace.readFile("docs/intro.md")).resolves.toBe("# Introduction\n")
    await expect(workspace.writeFile("docs/intro.md", "changed")).rejects.toThrow("read-only")
    await expect(workspace.rm("docs/intro.md")).rejects.toThrow("read-only")
    await expect(workspace.writeFile("drafts/notes.md", "notes")).resolves.toBe("drafts/notes.md")

    const session = await workspace.startSession({ paths: ["docs"] })
    try {
      await expect(session.readFile("docs/intro.md")).resolves.toBe("# Introduction\n")
      await expect(session.readFile("drafts/notes.md")).rejects.toThrow("does not exist")
      expect((await session.glob("**/*.md")).map(entry => entry.path)).toEqual(["docs/intro.md"])
      await expect(session.writeFile("drafts/new.md", "outside")).rejects.toThrow("outside the session scope")
    }
    finally {
      await session.close()
    }
  })
})
