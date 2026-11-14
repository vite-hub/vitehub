import { describe, expect, it } from "vitest"
import { Response as ForeignResponse } from "@whatwg-node/node-fetch"

import { hostReadableStream, isResponse } from "../src/internal/response.ts"

describe("Response detection", () => {
  it("accepts the Response that a server installs as the global after load, as srvx does in Nitro", () => {
    const native = globalThis.Response
    class ServerResponse {
      #init: ResponseInit | undefined
      constructor(_body?: unknown, init?: ResponseInit) {
        this.#init = init
      }

      get headers() {
        return new Headers(this.#init?.headers)
      }

      get status() {
        return this.#init?.status ?? 200
      }

      // srvx inherits the body fields from the native Response prototype.
      get bodyUsed() {
        return false
      }

      clone() {
        return this
      }

      async text() {
        return ""
      }
    }
    globalThis.Response = ServerResponse as unknown as typeof Response
    try {
      expect(isResponse(new ServerResponse(null, { status: 204 }))).toBe(true)
    }
    finally {
      globalThis.Response = native
    }
  })

  it("accepts native responses and their subclasses", () => {
    class CustomResponse extends Response {}
    expect(isResponse(new Response("native"))).toBe(true)
    expect(isResponse(new CustomResponse("subclass"))).toBe(true)
  })

  it("accepts foreign responses and their subclasses", () => {
    class CustomResponse extends ForeignResponse {}
    expect(isResponse(new ForeignResponse("foreign"))).toBe(true)
    expect(isResponse(new CustomResponse("subclass"))).toBe(true)
  })

  it("rejects values with status and headers but no Response body", () => {
    const axiosResponse = { config: {}, data: { userId: "user-123" }, headers: { get: () => "application/json" }, request: {}, status: 200, statusText: "OK" }
    expect(isResponse(axiosResponse)).toBe(false)
    expect(isResponse({ data: { done: true }, headers: new Headers(), status: 200 })).toBe(false)
  })
})

describe("hostReadableStream()", () => {
  it("releases the reader of a foreign body when the host stream is cancelled", async () => {
    const cancelled: unknown[] = []
    // A stream from another implementation: `reader.cancel()` keeps the lock until `releaseLock()`, as in the Streams Standard.
    const foreign = {
      locked: false,
      getReader() {
        foreign.locked = true
        return {
          cancel: async (reason: unknown) => { cancelled.push(reason) },
          read: async () => ({ done: false, value: "chunk" }),
          releaseLock: () => { foreign.locked = false },
        }
      },
    }
    // SAFETY: the object has the reader API that hostReadableStream uses.
    const body = hostReadableStream(foreign as unknown as ReadableStream<string>)
    expect(body).not.toBe(foreign)

    await body.cancel("stopped")

    expect(cancelled).toEqual(["stopped"])
    expect(foreign.locked).toBe(false)
  })
})
