import { expect, it } from "vitest"

import { contentStreamToBytes, sha256 } from "../src/core/path.ts"
import { materializeWorkspaceSources, sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

import type { WorkspaceStore } from "../src/core/types.ts"
import type { MaterializationControl } from "../src/sources/materialization.ts"

it.each([false, true])("cleans committed files after cancellation with streaming=%s", async (streaming) => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  const writeFile = store.writeFile.bind(store)
  const abort = new AbortController()
  const canceled = new Error("Canceled after content was committed")
  store.writeFile = async (path, file) => {
    const written = await writeFile(path, { ...file, metadata: undefined })
    abort.abort(canceled)
    return written
  }
  if (streaming) {
    store.writeFileStream = async (path, file) => {
      const content = await contentStreamToBytes(file.content)
      await writeFile(path, { path, content, mediaType: file.mediaType })
      abort.abort(canceled)
      return { path, type: "file", size: content.byteLength, digest: await sha256(content) }
    }
  }
  const control: MaterializationControl = {
    isCurrent: () => true,
    async mutate(operation) {
      abort.signal.throwIfAborted()
      return await operation()
    },
    async checkpoint(operation) { return await operation() },
  }
  let keys = ["committed.txt"]
  const definition = {
    name: "canceled-write",
    sources: {
      docs: {
        mount: "",
        materialize: "startup" as const,
        async getKeys() { return keys },
        async getItem(key: string) {
          return streaming
            ? {
                key,
                contentStream: new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("committed"))
                    controller.close()
                  },
                }),
              }
            : { key, content: "committed" }
        },
      },
    },
  }

  await expect(materializeWorkspaceSources(definition, store, { abortSignal: abort.signal }, control)).rejects.toBe(canceled)
  await expect(store.readFile("committed.txt")).resolves.toMatchObject({ metadata: undefined })
  await expect(store.getMeta!(sourceSnapshotMetaKey(definition.name, "docs"))).resolves.toMatchObject({
    status: "updating",
    items: { "committed.txt": { materializedContentDigest: await sha256("committed") } },
  })

  keys = []
  const retry = await materializeWorkspaceSources(definition, store)
  expect(retry.sources[0]).toMatchObject({ status: "ready", counts: { removed: 1 } })
  await expect(store.readFile("committed.txt")).resolves.toBeUndefined()
})
