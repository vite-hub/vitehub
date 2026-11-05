import { describe, expect, it } from "vitest"

import { installStandardContext } from "../src/runtime/h3.ts"
import { consoleRequestJSON } from "../src/console/runtime/server/request.ts"

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

function h3V1(req: Record<PropertyKey, unknown>): ConsoleRequestEvent {
  const event = { node: { req: { headers: { host: "localhost" }, method: "POST", url: "/", ...req }, res: {} } }
  installStandardContext(event)
  return event
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
  nodeBytes(body: string): ConsoleRequestEvent {
    return h3V1({
      async *[Symbol.asyncIterator]() {
        for (const byte of encoder.encode(body)) yield new Uint8Array([byte])
      },
    })
  },
  nodeText(body: string): ConsoleRequestEvent {
    return h3V1({
      async *[Symbol.asyncIterator]() {
        for (const character of body) yield character
      },
    })
  },
  // Nitro 2 on Workers: the Node request shim of H3 1 holds the body, already read.
  nitro2Bytes(body: string): ConsoleRequestEvent {
    return h3V1({ body: encoder.encode(body) })
  },
  nitro2Text(body: string): ConsoleRequestEvent {
    return h3V1({ body })
  },
}

describe("Console request bodies", () => {
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

  it("closes an oversized H3 v1 iterator without reading another chunk", async () => {
    let reads = 0
    let closed = false
    const event = h3V1({
      async *[Symbol.asyncIterator]() {
        try {
          reads++
          yield encoder.encode("12345")
          reads++
          yield encoder.encode("67890")
        }
        finally { closed = true }
      },
    })

    await expect(consoleRequestJSON(event, 4)).rejects.toMatchObject({ statusCode: 413 })
    expect(reads).toBe(1)
    expect(closed).toBe(true)
  })
})
