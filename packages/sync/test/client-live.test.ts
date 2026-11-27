import { describe, expect, it } from "vitest"

import { readEvents } from "../src/client/live.ts"

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function read(chunks: string[]) {
  const events = []
  for await (const event of readEvents(body(chunks))) events.push(event)
  return events
}

describe("readEvents", () => {
  it("reads events split across chunks, with CRLF, comments and data on many lines", async () => {
    expect(await read([
      ": ping\n\n",
      "event: pull\nid: 4\nda",
      "ta: {\"a\":1}\r",
      "\n\r\n",
      "data: one\ndata:two\n\n",
      "event: error\rdata: {}\r\r",
      "data: no end",
    ])).toEqual([
      { type: "pull", data: "{\"a\":1}" },
      { type: "message", data: "one\ntwo" },
      { type: "error", data: "{}" },
    ])
  })

  it("reads an event that ends with a `\\r` before the body ends", async () => {
    expect(await read(["event: change\rdata: ok\r\r"])).toEqual([{ type: "change", data: "ok" }])
    expect(await read(["data: a\r", "\r", "\ndata: b\r\n", "\r\n"])).toEqual([
      { type: "message", data: "a" },
      { type: "message", data: "b" },
    ])
    expect(await read(["event: pull\r", "\ndata: a\r", "\r"])).toEqual([{ type: "pull", data: "a" }])
  })

  it("yields an event that ends with a `\\r` while the body stays open", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start: c => void (controller = c) })
    controller.enqueue(new TextEncoder().encode("data: ok\r\r"))
    const events = readEvents(stream)
    expect((await events.next()).value).toEqual({ type: "message", data: "ok" })
    controller.close()
    expect((await events.next()).done).toBe(true)
  })

  it("decodes a character split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: é\n\n")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7))
        controller.enqueue(bytes.slice(7))
        controller.close()
      },
    })
    const events = []
    for await (const event of readEvents(stream)) events.push(event)
    expect(events).toEqual([{ type: "message", data: "é" }])
  })
})
