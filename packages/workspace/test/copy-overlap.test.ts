import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defineWorkspace } from "../src/core/define.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { useWorkspace } from "../src/core/use.ts"

const roots: string[] = []

afterEach(async () => {
  resetWorkspaceRegistry()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createFs(provider: "memory" | "local") {
  const root = await mkdtemp(join(tmpdir(), "vitehub-copy-overlap-"))
  roots.push(root)
  registerWorkspace("copy-overlap", defineWorkspace({
    store: provider === "local"
      ? { provider, root, locks: "process" }
      : { provider },
  }))
  return useWorkspace("copy-overlap", { mode: "write" }).fs
}

describe.each(["memory", "local"] as const)("%s Workspace copy overlap", (provider) => {
  describe.each(["copyPath", "movePath"] as const)("%s", (operation) => {
    it.each(["file", "directory"] as const)("preserves the %s source when overwrite targets an ancestor", async (kind) => {
      const fs = await createFs(provider)
      const source = kind === "file" ? "notes/source.md" : "notes/source"
      const file = kind === "file" ? source : `${source}/document.md`
      await fs.writeFile(file, "source content")
      await fs.writeFile("notes/neighbor.md", "neighbor content")

      let failure: unknown
      try { await fs[operation](source, "notes", { overwrite: true }) }
      catch (error) { failure = error }

      expect(await fs.exists(file)).toBe(true)
      await expect(fs.readFile(file)).resolves.toBe("source content")
      await expect(fs.readFile("notes/neighbor.md")).resolves.toBe("neighbor content")
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({ message: expect.stringContaining("Destination cannot contain the source") })
    })

    it.each(["file", "directory"] as const)("can overwrite a separate destination with a %s source", async (kind) => {
      const fs = await createFs(provider)
      const source = kind === "file" ? "notes-old/source.md" : "notes-old"
      await fs.writeFile("notes-old/source.md", "source content")
      await fs.writeFile("notes/previous.md", "replace me")

      await fs[operation](source, "notes", { overwrite: true })

      await expect(fs.readFile(kind === "file" ? "notes" : "notes/source.md")).resolves.toBe("source content")
      await expect(fs.exists("notes-old/source.md")).resolves.toBe(operation === "copyPath")
    })
  })
})
