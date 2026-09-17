import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(["docs", "docs/nested"])("lists a persisted startup snapshot after a file replaces mount %s or its ancestor", async (mount) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-startup-list-"))
  roots.push(root)
  const getItem = vi.fn(async (key: string) => ({ key, content: "generated" }))
  const definition = {
    name: "startup-list-replacement",
    sources: { generated: custom({ materialize: "startup", mount, async getKeys() { return ["file.md"] }, getItem }) },
  }
  await createWorkspaceSourceView(definition, createLocalWorkspaceStore(root)).list("")
  await rm(join(root, "docs"), { recursive: true })
  await writeFile(join(root, "docs"), "external replacement")

  const inspection = createWorkspaceSourceView(definition, createLocalWorkspaceStore(root), { reuseStartupSnapshots: true })
  await expect(inspection.list("")).resolves.toContainEqual(expect.objectContaining({ path: "docs", type: "file" }))
  await expect(inspection.list("", { recursive: true })).resolves.toContainEqual(expect.objectContaining({ path: "docs", type: "file" }))
  await expect(readFile(join(root, "docs"), "utf8")).resolves.toBe("external replacement")
  expect(getItem).toHaveBeenCalledTimes(1)

  // A later removal allows recovery of the missing mount.
  await rm(join(root, "docs"))
  await expect(inspection.list("", { recursive: true })).resolves.toContainEqual(expect.objectContaining({ path: `${mount}/file.md`, type: "file" }))
  expect(getItem).toHaveBeenCalledTimes(2)
})
