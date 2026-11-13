import { describe, expect, it } from "vitest"

import { consoleRequestJSON } from "../src/console/runtime/server/request.ts"
import { requestEvent } from "./console-event.ts"

import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

const encoder = new TextEncoder()

function standard(body: ReadableStream<Uint8Array>): ConsoleRequestEvent {
  return { "~standard": { vendor: "test", req: new Request("http://localhost/", { body, duplex: "half", method: "POST" } as RequestInit), res: {} } }
}

/** An event whose request body is exactly `body`, so a test can check the stream that the reader used. */
function streamEvent(body: ReadableStream<Uint8Array>): ConsoleRequestEvent {
  // SAFETY: consoleRequestJSON() reads only `body` of the request.
  return { "~standard": { vendor: "test", req: { body } as unknown as Request, res: {} } }
}

const adapters = {
  fetch(body: string) {
    const bytes = encoder.encode(body)
    return standard(new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte per chunk splits every multibyte character.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    }))
  },
}

describe("Console request bodies", () => {
  it.each([null, { collection: "posts" }])("reads an action body from Standard Context: %j", async (body) => {
    const req = new Request("http://vitehub.local/_vitehub/api/documents", {
      method: "POST",
      body: JSON.stringify(body),
    })

    await expect(consoleRequestJSON(requestEvent(req))).resolves.toEqual(body)
  })

  it("rejects a request with no JSON body", async () => {
    const req = new Request("http://vitehub.local/_vitehub/api/documents", { method: "POST" })
    await expect(consoleRequestJSON(requestEvent(req))).rejects.toBeInstanceOf(SyntaxError)
  })

  for (const [name, adapter] of Object.entries(adapters)) {
    it(`counts UTF-8 bytes at the exact limit through the ${name} adapter`, async () => {
      const body = JSON.stringify({ text: "café 🌍" })
      const bytes = encoder.encode(body).byteLength

      await expect(consoleRequestJSON(adapter(body), bytes)).resolves.toEqual({ text: "café 🌍" })
      await expect(consoleRequestJSON(adapter(body), bytes - 1)).rejects.toMatchObject({ statusCode: 413 })
    })
  }

  it("releases Fetch bodies after success or malformed JSON", async () => {
    const valid = adapters.fetch("{}")
    await expect(consoleRequestJSON(valid)).resolves.toEqual({})
    expect(valid["~standard"].req.body?.locked).toBe(false)

    const invalid = adapters.fetch("{")
    await expect(consoleRequestJSON(invalid)).rejects.toBeInstanceOf(SyntaxError)
    expect(invalid["~standard"].req?.body?.locked).toBe(false)
  })

  it("stops an oversized Fetch stream and preserves 413 when cancellation fails", async () => {
    let reads = 0
    let cancellations = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(encoder.encode("12345"))
      },
      cancel() {
        cancellations++
        throw new Error("cleanup failed")
      },
    }, { highWaterMark: 0 })

    await expect(consoleRequestJSON(streamEvent(body), 4)).rejects.toMatchObject({ statusCode: 413 })
    expect(reads).toBe(1)
    expect(cancellations).toBe(1)
    expect(body.locked).toBe(false)
  })

  it("preserves a Fetch read failure and releases its reader", async () => {
    const failure = new Error("connection closed")
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(failure) },
    })

    await expect(consoleRequestJSON(streamEvent(body))).rejects.toBe(failure)
    expect(body.locked).toBe(false)
  })

})
