import { link, mkdtemp, rm } from "node:fs/promises"
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

describe.each(["copyPath", "movePath"] as const)("Local Store %s filesystem aliases", (operation) => {
  it.for(["file", "directory"] as const)("preserves a %s source through a case alias", async (kind, context) => {
    const fs = await createFs("local")
    const source = kind === "file" ? "Notes/source.md" : "Notes/source"
    const file = kind === "file" ? source : `${source}/document.md`
    await fs.writeFile(file, "source content")
    await fs.writeFile("Notes/neighbor.md", "neighbor content")
    if (!await fs.exists("notes")) context.skip()

    await expect(fs[operation](source, "notes", { overwrite: true }))
      .rejects.toThrow("Destination cannot contain the source")
    await expect(fs.readFile(file)).resolves.toBe("source content")
    await expect(fs.readFile("Notes/neighbor.md")).resolves.toBe("neighbor content")
  })

  it("rejects another name for the same source file", async () => {
    const fs = await createFs("local")
    await fs.writeFile("source.md", "source content")
    const root = roots.at(-1)!
    await link(join(root, "source.md"), join(root, "alias.md"))

    await expect(fs[operation]("source.md", "alias.md", { overwrite: true }))
      .rejects.toThrow("Destination cannot contain the source")
    await expect(fs.readFile("source.md")).resolves.toBe("source content")
    await expect(fs.readFile("alias.md")).resolves.toBe("source content")
  })

  it("allows distinct paths with different casing on case-sensitive filesystems", async (context) => {
    const fs = await createFs("local")
    await fs.writeFile("Notes/source.md", "source content")
    if (await fs.exists("notes")) context.skip()
    await fs.writeFile("notes/previous.md", "replace me")

    await fs[operation]("Notes/source.md", "notes", { overwrite: true })

    await expect(fs.readFile("notes")).resolves.toBe("source content")
    await expect(fs.exists("Notes/source.md")).resolves.toBe(operation === "copyPath")
  })
})
