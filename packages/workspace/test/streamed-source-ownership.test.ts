import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import { contentStreamToBytes } from "../src/core/path.ts"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { materializeWorkspaceSources, reconcileRemovedStartupSources } from "../src/sources/materialization.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceStore } from "../src/core/types.ts"

function createBlobDigestStore(): WorkspaceStore {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  const stat = store.stat.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  store.stat = async (path) => {
    const entry = await stat(path)
    const file = entry?.type === "file" ? await store.readFile(path) : undefined
    if (!entry || !file) return entry
    const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content
    return { ...entry, digest: createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex") }
  }
  store.writeFileStream = async (path, file) => {
    await store.writeFile(path, { ...file, content: await contentStreamToBytes(file.content) })
    const entry = await store.stat(path)
    return { ...entry!, digest: entry!.digest! }
  }
  return store
}

async function* content() {
  yield new TextEncoder().encode("streamed ")
  yield new Uint8Array([0, 1, 254, 255])
}

it.each([false, true])("cleans streamed startup output with provider digests and preserves replacements=%s", async (replace) => {
  const store = createBlobDigestStore()
  const getItem = vi.fn(async (key: string) => ({ key, contentStream: content() }))
  const definition = {
    name: crypto.randomUUID(),
    sources: { docs: custom({
      materialize: "startup",
      mount: "",
      async getKeys() { return ["file.bin"] },
      getItem,
    }) },
  }
  await materializeWorkspaceSources(definition, store)
  const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
  await expect(inspection.readFile("file.bin", { encoding: "binary" })).resolves.toEqual(await contentStreamToBytes(content()))
  expect(getItem).toHaveBeenCalledTimes(1)
  const repeated = await materializeWorkspaceSources(definition, store)
  expect(repeated.sources[0]?.counts?.unchanged).toBe(1)
  if (replace) await store.writeFile("file.bin", { path: "file.bin", content: "external" })
  await reconcileRemovedStartupSources(definition.name, store, [])
  if (replace) await expect(store.readFile("file.bin")).resolves.toMatchObject({ content: "external" })
  else await expect(store.readFile("file.bin")).resolves.toBeUndefined()
})

it.each([false, true])("cleans streamed build loader output with provider digests and preserves replacements=%s", async (replace) => {
  const store = createBlobDigestStore()
  const name = crypto.randomUUID()
  await syncWorkspaceDefinition({
    name,
    sources: { docs: custom({ materialize: "build", mount: "", files: [] }) },
    loaders: [{ name: "stream", async load(ctx) {
      const written = await ctx.store.writeFileStream!("file.bin", { path: "file.bin", content: content() })
      expect(written.digest).toHaveLength(40)
    } }],
  }, store)
  if (replace) await store.writeFile("file.bin", { path: "file.bin", content: "external" })
  await syncWorkspaceDefinition({ name, sources: {} }, store)
  if (replace) await expect(store.readFile("file.bin")).resolves.toMatchObject({ content: "external" })
  else await expect(store.readFile("file.bin")).resolves.toBeUndefined()
})
