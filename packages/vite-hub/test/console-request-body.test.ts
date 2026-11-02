import { describe, expect, it } from "vitest"

import { consoleRequestJSON } from "../src/console/runtime/server/request.ts"

import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

const encoder = new TextEncoder()

const adapters = {
  fetch(body: string): ConsoleRequestEvent {
    const bytes = encoder.encode(body)
    return { req: { body: new ReadableStream({
      start(controller) {
        // One byte per chunk splits every multibyte character.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    }) } }
  },
  nodeBytes(body: string): ConsoleRequestEvent {
    return { node: { req: {
      async *[Symbol.asyncIterator]() {
        for (const byte of encoder.encode(body)) yield new Uint8Array([byte])
      },
    } } }
  },
  nodeText(body: string): ConsoleRequestEvent {
    return { node: { req: {
      async *[Symbol.asyncIterator]() {
        for (const character of body) yield character
      },
    } } }
  },
  // Nitro 2 on Workers: H3 v1 `event.req` is the Node request shim, whose body is already read.
  nitro2Bytes(body: string): ConsoleRequestEvent {
    return { req: { body: encoder.encode(body) } }
  },
  nitro2Text(body: string): ConsoleRequestEvent {
    return { req: { body } }
  },
  decoded(body: string): ConsoleRequestEvent {
    return { req: { json: async () => JSON.parse(body) } }
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
    expect(valid.req?.body?.locked).toBe(false)

    const invalid = adapters.fetch("{")
    await expect(consoleRequestJSON(invalid)).rejects.toBeInstanceOf(SyntaxError)
    expect(invalid.req?.body?.locked).toBe(false)
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

    await expect(consoleRequestJSON({ req: { body } }, 4)).rejects.toMatchObject({ statusCode: 413 })
    expect(reads).toBe(1)
    expect(cancellations).toBe(1)
    expect(body.locked).toBe(false)
  })

  it("preserves a Fetch read failure and releases its reader", async () => {
    const failure = new Error("connection closed")
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(failure) },
    })

    await expect(consoleRequestJSON({ req: { body } })).rejects.toBe(failure)
    expect(body.locked).toBe(false)
  })

  it("closes an oversized H3 v1 iterator without reading another chunk", async () => {
    let reads = 0
    let closed = false
    const event: ConsoleRequestEvent = { node: { req: {
      async *[Symbol.asyncIterator]() {
        try {
          reads++
          yield encoder.encode("12345")
          reads++
          yield encoder.encode("67890")
        }
        finally { closed = true }
      },
    } } }

    await expect(consoleRequestJSON(event, 4)).rejects.toMatchObject({ statusCode: 413 })
    expect(reads).toBe(1)
    expect(closed).toBe(true)
  })
})
