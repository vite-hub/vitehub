import { expect, it } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

const operations = ["stat", "exists", "list", "glob", "search"] as const

it.each(operations.flatMap(operation => ["removed", "other-workspace"].map(replacement => ({ operation, replacement }))))(
  "restores root startup ownership after $replacement before $operation with an unrelated lazy Source",
  async ({ operation, replacement }) => {
    const store = createMemoryWorkspaceStore()
    const source = (content: string) => custom({
      materialize: "startup",
      mount: "",
      files: [{ path: "shared.md", content }],
    })
    const view = createWorkspaceSourceView({
      name: "first",
      sources: {
        startup: source("first"),
        lazy: custom({ materialize: "lazy", mount: "", files: [{ path: "other.md", content: "lazy" }] }),
      },
    }, store)
    await expect(view.readFile("shared.md")).resolves.toBe("first")
    if (replacement === "removed") await store.rm("shared.md")
    else {
      const other = createWorkspaceSourceView({ name: "second", sources: { startup: source("second") } }, store)
      await expect(other.readFile("shared.md")).resolves.toBe("second")
    }

    if (operation === "search") {
      await expect(view.search({ pattern: "first" })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ path: "shared.md" })]))
    }
    else if (operation === "glob") {
      await expect(view.glob("*.md")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ path: "shared.md" })]))
    }
    else if (operation === "list") {
      await expect(view.list("")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ path: "shared.md" })]))
    }
    else if (operation === "exists") await expect(view.exists("shared.md")).resolves.toBe(true)
    else await expect(view.stat("shared.md")).resolves.toMatchObject({ metadata: { workspaceSourceOwner: "first" } })
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "first" })
  },
)
