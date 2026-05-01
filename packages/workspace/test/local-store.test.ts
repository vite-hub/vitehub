import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createLocalWorkspaceStore } from "../src/stores/local.ts"

const tempDirs: string[] = []

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
  tempDirs.push(root)
  return createLocalWorkspaceStore(root)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("local workspace store", () => {
  it("supports file tree operations, snapshots, and diffs", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.mkdir("generated")

    expect(await store.readFile("docs/readme.md")).toMatchObject({ path: "docs/readme.md" })
    expect(await store.stat("docs/readme.md")).toMatchObject({ type: "file", path: "docs/readme.md" })
    expect(await store.glob("**/*.md")).toHaveLength(1)
    expect(await store.list("", { recursive: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
      expect.objectContaining({ path: "generated", type: "directory" }),
    ]))

    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "changed" })
    await store.writeFile("generated/notes.md", { path: "generated/notes.md", content: "notes" })
    const diff = await store.diff({ from: snapshot })

    expect(diff.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "modified" }),
      expect.objectContaining({ path: "generated/notes.md", type: "added" }),
    ]))

    await store.rm("generated", { recursive: true })
    expect(await store.stat("generated")).toBeUndefined()
  })
})
