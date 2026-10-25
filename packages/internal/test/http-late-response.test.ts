import { expect, it, vi } from "vitest"

import { executeHttpRequest } from "../src/http-request.ts"

it("cancels a response arriving after caller cancellation without reading it", async () => {
  const incoming = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  const reason = new Error("caller stopped")
  const operation = executeHttpRequest({ url: "https://example.test/late" }, {
    fetch: async () => {
      started.resolve()
      return incoming.promise
    },
    signal: controller.signal,
  })
  const rejection = expect(operation).rejects.toBe(reason)
  await started.promise
  controller.abort(reason)
  await rejection

  const cancel = vi.fn()
  const pull = vi.fn()
  incoming.resolve(new Response(new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 })))
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  expect(pull).not.toHaveBeenCalled()
})
