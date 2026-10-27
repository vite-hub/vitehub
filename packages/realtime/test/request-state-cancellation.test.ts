import { describe, expect, it, vi } from "vitest"

import { readRealtimeRequestState } from "../src/transport.ts"

describe.each([
  { chunk: new Uint8Array(5), statusCode: 413 },
  { chunk: "invalid bytes", statusCode: 400 },
])("Realtime request rejection ($statusCode)", ({ chunk, statusCode }) => {
  it.each(["rejects", "stalls"])("preserves the HTTP error when cancellation %s", async (cleanup) => {
    let finishCancellation = () => {}
    const pendingCancellation = new Promise<void>((resolve) => { finishCancellation = resolve })
    const cancel = vi.fn(() => {
      if (cleanup === "rejects") throw new Error("stream cleanup failed")
      return pendingCancellation
    })
    const body = new ReadableStream<unknown>({
      start(controller) { controller.enqueue(chunk) },
      cancel,
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)
    const settled = vi.fn()
    const read = readRealtimeRequestState(request, 4).then(settled, settled)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ statusCode }))
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    }
    finally {
      finishCancellation()
      await read
    }
  })
})
