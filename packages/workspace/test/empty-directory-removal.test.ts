import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rmdir: vi.fn(actual.rmdir) }
})

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
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
  await expect(store.removeEmptyDirectory!("replacement/missing")).resolves.toBeUndefined()
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
  expect((await lstat(join(root, "replacement"))).isSymbolicLink()).toBe(true)
  await expect(readFile(join(root, "replacement"), "utf8")).resolves.toBe("keep")
})

it("local directory removal does not pass a junction to rmdir", async () => {
  const root = await localRoot()
  const store = createLocalWorkspaceStore(root)
  const target = join(root, "target")
  const replacement = join(root, "replacement")
  await mkdir(target)
  await writeFile(join(target, "keep.txt"), "keep")
  await symlink(target, replacement, "junction")

  await store.removeEmptyDirectory!("replacement")

  expect(rmdir).not.toHaveBeenCalledWith(replacement)
  expect((await lstat(replacement)).isSymbolicLink()).toBe(true)
  await expect(readFile(join(target, "keep.txt"), "utf8")).resolves.toBe("keep")
})
