import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { createMemoryWorkspaceStore, forkMemoryWorkspaceStore } from "../src/storage/memory.ts"

const digest = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex")

it("keeps digests consistent when callers mutate input and returned bytes", async () => {
  const store = createMemoryWorkspaceStore()
  const content = new Uint8Array([1, 2, 3])
  const expected = digest(content)
  await store.writeFile("file.bin", { path: "file.bin", content })
  expect((await store.stat("file.bin"))?.digest).toBe(expected)

  content.fill(0)
  const read = await store.readFile("file.bin")
  expect(read?.content).toBeInstanceOf(Uint8Array)
  ;(read!.content as Uint8Array).fill(0)

  expect((await store.list())[0]?.digest).toBe(expected)
  expect((await store.snapshot()).entries["file.bin"]?.digest).toBe(expected)
  expect((await store.readFile("file.bin"))?.content).toEqual(new Uint8Array([1, 2, 3]))
})

it.each([false, true])("refreshes digests after replacement (conditional: %s)", async (conditional) => {
  const store = createMemoryWorkspaceStore()
  await store.writeFile("file.txt", { path: "file.txt", content: "before" })
  const before = await store.snapshot()
  const next = { path: "file.txt", content: "after" }
  if (conditional) await store.writeFileConditional!(next.path, next, digest("before"))
  else await store.writeFile(next.path, next)

  expect((await store.stat(next.path))?.digest).toBe(digest("after"))
  expect((await store.list())[0]?.digest).toBe(digest("after"))
  expect((await store.diff({ from: before })).entries).toMatchObject([
    { path: next.path, type: "modified", before: { digest: digest("before") }, after: { digest: digest("after") } },
  ])
  await expect(store.writeFileConditional!(next.path, { ...next, content: "stale" }, digest("before"))).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
  await store.rm(next.path)
  await store.writeFile(next.path, { ...next, content: "" })
  expect((await store.stat(next.path))?.digest).toBe(digest(""))
})

it("forks inspected files and updates their digests independently", async () => {
  const store = createMemoryWorkspaceStore()
  await store.writeFile("file.txt", { path: "file.txt", content: "original" })
  await store.snapshot()
  const fork = forkMemoryWorkspaceStore(store)
  expect((await fork.stat("file.txt"))?.digest).toBe(digest("original"))
  await fork.writeFileConditional!("file.txt", { path: "file.txt", content: "fork" }, digest("original"))
  await store.writeFile("file.txt", { path: "file.txt", content: "parent" })
  expect((await fork.stat("file.txt"))?.digest).toBe(digest("fork"))
  expect((await store.stat("file.txt"))?.digest).toBe(digest("parent"))
  expect((await fork.diff()).entries).toMatchObject([
    { path: "file.txt", type: "modified", before: { digest: digest("original") }, after: { digest: digest("fork") } },
  ])
})
