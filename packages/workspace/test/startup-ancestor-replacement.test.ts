import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([false, true].flatMap(local => ["", "generated"].flatMap(mount => ["list", "readFile"].map(first => ({ local, mount, first })))))("reuses startup snapshots with a file replacing an indexed ancestor: %j", async ({ local, mount, first }) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-startup-ancestor-"))
  roots.push(root)
  const store = local ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
  const getKeys = vi.fn(async () => ["docs/a.md", "keep.md"])
  const definition = {
    name: "startup-ancestor-replacement",
    sources: {
      content: custom({
        materialize: "startup",
        mount,
        getKeys,
        async getItem(key) { return { key, content: `original ${key}` } },
      }),
    },
  }
  await createWorkspaceSourceView(definition, store).materializeSources()
  const prefix = mount ? `${mount}/` : ""
  const path = `${prefix}docs`
  if (local) {
    await rm(join(root, path), { recursive: true })
    await writeFile(join(root, path), "external replacement")
  }
  else {
    await store.rm(path, { recursive: true })
    await store.writeFile(path, { path, content: "external replacement" })
  }
  getKeys.mockClear()
  const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots: true })

  if (first === "readFile") await expect(view.readFile(path)).resolves.toBe("external replacement")
  await expect(view.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ path, type: "file" }),
    expect.objectContaining({ path: `${prefix}keep.md`, type: "file" }),
  ]))
  await expect(view.readFile(path)).resolves.toBe("external replacement")
  await expect(view.readFile(`${prefix}keep.md`)).resolves.toBe("original keep.md")
  expect(getKeys).not.toHaveBeenCalled()
})
