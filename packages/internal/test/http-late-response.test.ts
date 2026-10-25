import { expect, it, vi } from "vitest"

import { executeHttpRequest } from "../src/http-request.ts"

it("cancels a response arriving after caller cancellation without reading it", async () => {
  let deliver!: (response: Response) => void
  const incoming = new Promise<Response>((resolve) => { deliver = resolve })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const controller = new AbortController()
  const reason = new Error("caller stopped")
  const operation = executeHttpRequest({ url: "https://example.test/late" }, {
    fetch: async () => {
      markStarted()
      return incoming
    },
    signal: controller.signal,
  })
  const rejection = expect(operation).rejects.toBe(reason)
  await started
  controller.abort(reason)
  await rejection

  const cancel = vi.fn()
  const pull = vi.fn()
  deliver(new Response(new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 })))
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  expect(pull).not.toHaveBeenCalled()
})
