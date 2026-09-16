import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function localRoot() {
  const root = await mkdtemp(join(tmpdir(), "empty-directory-removal-"))
  roots.push(root)
  return root
}

it.each(["memory", "local"] as const)("%s removes only empty directories", async (provider) => {
  const store = provider === "memory" ? createMemoryWorkspaceStore() : createLocalWorkspaceStore(await localRoot())
  await store.mkdir("empty")
  await store.removeEmptyDirectory!("empty")
  await expect(store.stat("empty")).resolves.toBeUndefined()
  await expect(store.removeEmptyDirectory!("missing")).resolves.toBeUndefined()

  await store.writeFile("replacement", { path: "replacement", content: "keep" })
  await store.removeEmptyDirectory!("replacement")
  expect(Buffer.from((await store.readFile("replacement"))!.content).toString()).toBe("keep")

  await store.writeFile("occupied/keep.md", { path: "occupied/keep.md", content: "keep" })
  await expect(store.removeEmptyDirectory!("occupied")).rejects.toThrow()
  expect(Buffer.from((await store.readFile("occupied/keep.md"))!.content).toString()).toBe("keep")
})

it("local directory removal preserves a symlink replacement", async () => {
  const root = await localRoot()
  const store = createLocalWorkspaceStore(root)
  await writeFile(join(root, "target"), "keep")
  await symlink(join(root, "target"), join(root, "replacement"))
  await store.removeEmptyDirectory!("replacement")
  expect(Buffer.from((await store.readFile("replacement"))!.content).toString()).toBe("keep")
})
