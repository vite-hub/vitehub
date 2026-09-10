import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createWorkspace } from "../src/core/workspace.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const cycle: Record<string, unknown> = {}
cycle.self = cycle
const invalid = [1n, cycle, { nested: undefined }, NaN, Infinity, -0, new Date(), () => {}, Symbol(), [undefined], Array(1)]

describe("portable file metadata", () => {
  it.each(["local", "memory"])("rejects invalid Source ownership in %s writes without replacing the file", async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "workspace-metadata-"))
    roots.push(root)
    const store = provider === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    await store.writeFile("file", { path: "file", content: "original", metadata: { source: "original" } })
    for (const source of [123, null, false, {}, []]) {
      const file = { path: "file", content: "replacement", metadata: { source } }
      await expect(store.writeFile("file", file)).rejects.toThrow("metadata.source must be a string")
      await expect(store.writeFileConditional!("file", file, (await store.stat("file"))!.digest!)).rejects.toThrow("metadata.source must be a string")
    }
    expect((await store.readFile("file"))?.metadata).toEqual({ source: "original" })
    const saved = await store.readFile("file")
    expect(typeof saved?.content === "string" ? saved.content : new TextDecoder().decode(saved?.content as Uint8Array)).toBe("original")
  })

  it.each(["local", "memory"])("rejects lossy %s metadata without replacing content or attributes", async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "workspace-metadata-"))
    roots.push(root)
    const store = provider === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    await store.writeFile("file", { path: "file", content: "original", metadata: { owner: "original" } })
    for (const value of invalid) {
      await expect(store.writeFile("file", { path: "file", content: "replacement", metadata: { value } })).rejects.toThrow("JSON-safe")
      await expect(store.writeFileConditional!("file", { path: "file", content: "replacement", metadata: { value } }, (await store.stat("file"))!.digest!)).rejects.toThrow("JSON-safe")
    }
    const saved = await store.readFile("file")
    expect(saved?.metadata).toEqual({ owner: "original" })
    expect(typeof saved?.content === "string" ? saved.content : new TextDecoder().decode(saved?.content as Uint8Array)).toBe("original")
  })

  it("rejects streamed metadata before consuming the stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-metadata-"))
    roots.push(root)
    const store = createLocalWorkspaceStore(root)
    const consumed = vi.fn()
    async function* content() { consumed(); yield new TextEncoder().encode("replacement") }
    await expect(store.writeFileStream!("file", { path: "file", content: content(), metadata: { revision: 1n } })).rejects.toThrow("JSON-safe")
    expect(consumed).not.toHaveBeenCalled()
    expect(await store.stat("file")).toBeUndefined()
  })

  it("preserves nested values after restart and accepts repeated noncyclic references", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-metadata-"))
    roots.push(root)
    const shared = { values: [null, true, 12, "text"] }
    const metadata = { first: shared, second: shared }
    await createLocalWorkspaceStore(root).writeFile("file", { path: "file", content: "content", metadata })
    expect((await createLocalWorkspaceStore(root).readFile("file"))?.metadata).toEqual(metadata)
  })

  it.each([undefined, null])("rejects caller-supplied Source ownership before dispatch (ifDigest: %s)", async (ifDigest) => {
    const store = createMemoryWorkspaceStore()
    const write = vi.spyOn(store, "writeFile")
    const conditionalWrite = vi.spyOn(store, "writeFileConditional")
    const workspace = createWorkspace({ name: "test", store })
    await expect(workspace.writeFile("file", "content", { metadata: { source: "docs" }, ifDigest })).rejects.toThrow("reserved for Source materialization")
    expect(write).not.toHaveBeenCalled()
    expect(conditionalWrite).not.toHaveBeenCalled()
    expect(await store.stat("file")).toBeUndefined()
    await store.writeFile("file", { path: "file", content: "materialized", metadata: { source: "docs" } })
    expect((await store.readFile("file"))?.metadata).toEqual({ source: "docs" })
  })

  it("rejects Source ownership introduced by a write validator", async () => {
    const store = createMemoryWorkspaceStore()
    const workspace = createWorkspace({
      name: "test",
      store,
      rules: { "**": { write: true, validate: input => ({ ...input, metadata: { source: "docs" } }) } },
    })
    await expect(workspace.writeFile("file", "content")).rejects.toThrow("reserved for Source materialization")
    expect(await store.stat("file")).toBeUndefined()
  })

  it("rejects invalid values before dispatching to a custom provider", async () => {
    const store = createMemoryWorkspaceStore()
    const write = vi.spyOn(store, "writeFile")
    const workspace = createWorkspace({ name: "test", store })
    await expect(workspace.writeFile("file", "content", { metadata: { nested: { value: undefined } } })).rejects.toThrow("JSON-safe")
    await expect(workspace.writeFile("file", "content", { metadata: { source: 123 } })).rejects.toThrow("metadata.source must be a string")
    expect(write).not.toHaveBeenCalled()
  })
})
