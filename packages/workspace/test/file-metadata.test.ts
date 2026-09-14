import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { copyJsonFileMetadata } from "../src/core/file-metadata.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
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

  it.each(["ordinary", "conditional", "streamed"])("copies accepted metadata in %s writes, including unchanged content", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "workspace-metadata-"))
    roots.push(root)
    const store = createLocalWorkspaceStore(root)
    for (const revision of [1, 2]) {
      const metadata = { nested: { revision }, source: "docs" }
      const file = { path: "file", content: "content", metadata }
      if (mode === "streamed") {
        async function* content() { yield new TextEncoder().encode(file.content) }
        await store.writeFileStream!("file", { ...file, content: content() })
      } else if (mode === "conditional") {
        await store.writeFileConditional!("file", file, (await store.stat("file"))?.digest ?? null)
      } else {
        await store.writeFile("file", file)
      }
      metadata.nested.revision = 99
      metadata.source = "changed"
      expect((await store.readFile("file"))?.metadata).toEqual({ nested: { revision }, source: "docs" })
    }
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

it("copies descriptor values without reading proxy properties", () => {
  const get = vi.fn(() => 123)
  const nested = new Proxy({ labels: new Proxy(["docs"], { get }) }, { get })
  const metadata = new Proxy({ source: "docs", nested }, { get })
  const copy = copyJsonFileMetadata("file.txt", metadata)
  expect(copy).toEqual({ source: "docs", nested: { labels: ["docs"] } })
  expect(structuredClone(copy)).toEqual(copy)
  expect(JSON.parse(JSON.stringify(copy))).toEqual(copy)
  expect(get).not.toHaveBeenCalled()
})

it.each(["memory", "local", "stream"])("persists validated proxy metadata through %s writes", async (provider) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-proxy-metadata-"))
  try {
    const store = provider === "memory" ? createMemoryWorkspaceStore() : createLocalWorkspaceStore(root)
    const get = vi.fn(() => 123)
    const metadata = new Proxy({ source: "docs", nested: { label: "original" } }, { get })
    if (provider === "stream") {
      await store.writeFileStream!("file.txt", { path: "file.txt", metadata, content: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("content")); controller.close() } }) })
    }
    else await store.writeFile("file.txt", { path: "file.txt", content: "content", metadata })
    const reader = provider === "memory" ? store : createLocalWorkspaceStore(root)
    await expect(reader.readFile("file.txt")).resolves.toMatchObject({ metadata: { source: "docs", nested: { label: "original" } } })
    expect(get).not.toHaveBeenCalled()
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

it("dispatches plain metadata to the Store from the public write boundary", async () => {
  const store = createMemoryWorkspaceStore()
  const write = vi.spyOn(store, "writeFile")
  const get = vi.fn(() => 123)
  const view = createWorkspaceSourceView({ name: "proxy-metadata" }, store)
  await view.writeFile("file.txt", "content", { metadata: new Proxy({ nested: { label: "original" } }, { get }) })
  const metadata = write.mock.calls[0]![1].metadata
  expect(structuredClone(metadata)).toEqual({ nested: { label: "original" } })
  expect(get).not.toHaveBeenCalled()
})
