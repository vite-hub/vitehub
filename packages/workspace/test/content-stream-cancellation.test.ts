import { expect, it, vi } from "vitest"

import { contentStreamChunks, contentStreamToBytes } from "../src/core/path.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

import type { WorkspaceStore } from "../src/core/types.ts"

it("cancels a Source stream when the streaming Store fails after reading a chunk", async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    cancel,
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
  })
  const failure = new Error("Store write failed")
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  store.writeFileStream = async (_path, file) => {
    for await (const _chunk of contentStreamChunks(file.content)) throw failure
    throw new Error("Expected Source content")
  }

  await expect(materializeWorkspaceSources({
    name: "failed-stream-write",
    sources: { docs: {
      mount: "",
      materialize: "startup",
      async getKeys() { return ["file.bin"] },
      async getItem(key: string) { return { key, contentStream: stream } },
    } },
  }, store)).resolves.toMatchObject({ sources: [{ status: "error", error: failure.message }] })

  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
  await expect(store.readFile("file.bin")).resolves.toBeUndefined()
})

it("cancels an open stream when its consumer stops early", async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    cancel,
    start(controller) { controller.enqueue(new Uint8Array([1])) },
  })

  for await (const chunk of contentStreamChunks(stream)) {
    expect(chunk).toEqual(new Uint8Array([1]))
    break
  }

  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
})

it("releases completed streams without canceling them", async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    cancel,
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.close()
    },
  })

  await expect(contentStreamToBytes(stream)).resolves.toEqual(new Uint8Array([1, 2, 3]))
  expect(cancel).not.toHaveBeenCalled()
  expect(stream.locked).toBe(false)
})

it("releases the reader even when cancellation fails", async () => {
  const failure = new Error("Source cancellation failed")
  const stream = new ReadableStream<Uint8Array>({
    cancel() { throw failure },
    start(controller) { controller.enqueue(new Uint8Array([1])) },
  })
  const iterator = contentStreamChunks(stream)
  await iterator.next()

  await expect(iterator.return(undefined)).rejects.toBe(failure)
  expect(stream.locked).toBe(false)
})

it("preserves Source read errors and releases the reader", async () => {
  const failure = new Error("Source read failed")
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(failure) },
  })

  await expect(contentStreamToBytes(stream)).rejects.toBe(failure)
  expect(stream.locked).toBe(false)
})
