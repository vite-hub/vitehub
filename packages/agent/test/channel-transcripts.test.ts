import type { Adapter, Thread } from "chat"
import { describe, expect, it, vi } from "vitest"

import { recordTranscriptsOfThread } from "../src/server/routes.ts"

describe("thread transcript ownership", () => {
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
