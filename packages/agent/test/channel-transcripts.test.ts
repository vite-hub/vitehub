import type { Adapter, Thread } from "chat"
import { describe, expect, it, vi } from "vitest"

import { postChatErrorFallback, recordTranscriptsOfThread } from "../src/server/routes.ts"

describe("thread transcript ownership", () => {
  it("accepts an on-time fallback when recording takes past the delivery deadline", async () => {
    vi.useFakeTimers()
    try {
      let finishRecording!: () => void
      const recording = new Promise<void>((resolve) => { finishRecording = resolve })
      let startRecording!: () => void
      const recordingStarted = new Promise<void>((resolve) => { startRecording = resolve })
      const outbound = vi.fn<Parameters<typeof recordTranscriptsOfThread>[1]["outbound"]>(async () => {
        startRecording()
        await recording
      })
      const remove = vi.fn(async () => {})
      const adapter = { name: "telegram" }
      // SAFETY: The stand-in implements the Thread methods exercised by fallback delivery.
      const raw = { adapter, id: "source", post: async () => ({ delete: remove, id: "fallback" }) } as unknown as Thread
      const thread = recordTranscriptsOfThread(raw, { inbound: async () => {}, outbound }, "account:alice")
      const delivered = postChatErrorFallback(
        new Error("failed"),
        thread,
        // SAFETY: Error fallback delivery reads only the triggering message id and thread id.
        { id: "inbound", threadId: "source" } as never,
        { errorFallbackText: "Fallback" },
        undefined,
        undefined,
        [],
        undefined,
        Date.now() - 1_990,
      )
      await recordingStarted
      await vi.advanceTimersByTimeAsync(25)
      finishRecording()
      await expect(delivered).resolves.toBe(true)
      expect(remove).not.toHaveBeenCalled()
      expect(outbound).toHaveBeenCalledExactlyOnceWith(adapter, "source", "fallback", "Fallback", "account:alice")
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps adapter posts, edits and streams scoped to the triggering thread", async () => {
    const outbound = vi.fn<Parameters<typeof recordTranscriptsOfThread>[1]["outbound"]>(async () => {})
    const adapter = {
      postMessage: async () => ({ id: "sent" }),
      editMessage: async () => ({ id: "edited" }),
      stream: async (_threadId: string, chunks: AsyncIterable<unknown>) => {
        for await (const _chunk of chunks) { /* Consume the adapter's stream. */ }
        return { id: "streamed" }
      },
    }
    // SAFETY: The stand-ins implement the Thread and Adapter methods exercised by these deliveries.
    const raw = { adapter: adapter as unknown as Adapter, id: "source" } as Thread
    const recorder = { inbound: async () => {}, outbound }
    const alice = recordTranscriptsOfThread(raw, recorder, "account:alice")
    const bob = recordTranscriptsOfThread(raw, recorder, "account:bob")
    for (const [thread, owner] of [[alice, "account:alice"], [bob, "account:bob"]] as const) {
      for (const destination of ["source", "private-destination"]) {
        const stream = (async function* () { yield "streamed text" })()
        await thread.adapter.postMessage(destination, "posted text")
        await thread.adapter.editMessage(destination, "edited", "edited text")
        await thread.adapter.stream!(destination, stream)
        const calls = outbound.mock.calls.slice(-3)
        expect(calls.map(call => call.slice(1))).toEqual([
          [destination, "sent", "posted text", destination === "source" ? owner : null],
          [destination, "edited", "edited text", destination === "source" ? owner : null],
          [destination, "streamed", "streamed text", destination === "source" ? owner : null],
        ])
      }
    }
  })
})
