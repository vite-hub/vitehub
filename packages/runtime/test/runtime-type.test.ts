import { afterEach, describe, expect, it } from "vitest"

import { hasRuntimeType, isRuntimeResponse } from "../src/internal/runtime-type.ts"

describe("Runtime representation guards", () => {
  it("distinguishes callable and object representations", () => {
    expect(hasRuntimeType(null, "object")).toBe(true)
    expect(hasRuntimeType({}, "object")).toBe(true)
    expect(hasRuntimeType(() => undefined, "function")).toBe(true)
    const spoofed = { [Symbol.toStringTag]: "Function" }
    expect(hasRuntimeType(spoofed, "function")).toBe(false)
    expect(hasRuntimeType(spoofed, "object")).toBe(true)
    const hostile = new Proxy({}, { get() { throw new Error("blocked property") } })
    expect(hasRuntimeType(hostile, "object")).toBe(true)
    expect(hasRuntimeType(hostile, "function")).toBe(false)
  })

  it("accepts only Responses of this runtime", () => {
    expect(isRuntimeResponse(new Response(null, { status: 401 }))).toBe(true)
    expect(isRuntimeResponse(new Proxy(new Response(null, { status: 401 }), {}))).toBe(false)
    expect(isRuntimeResponse(Object.create(Response.prototype))).toBe(false)
    expect(isRuntimeResponse({ [Symbol.toStringTag]: "Response", status: 401 })).toBe(false)
    expect(isRuntimeResponse(null)).toBe(false)
  })

  describe("with a server Response class", () => {
    const native = globalThis.Response
    afterEach(() => {
      globalThis.Response = native
    })

    it("accepts Responses of the class that the server installed as the global Response", () => {
      // Like srvx's NodeResponse: its getters read private fields.
      class ServerResponse {
        #status: number
        constructor(_body?: unknown, init?: { status?: number }) {
          this.#status = init?.status ?? 200
        }

        get status(): number {
          return this.#status
        }
      }
      // SAFETY: The test replaces the global class as srvx does on Node.js.
      globalThis.Response = ServerResponse as unknown as typeof Response
      expect(isRuntimeResponse(new ServerResponse(null, { status: 401 }))).toBe(true)
      expect(isRuntimeResponse(new native(null, { status: 401 }))).toBe(true)
      expect(isRuntimeResponse(Object.create(ServerResponse.prototype))).toBe(false)
      expect(isRuntimeResponse(new Proxy(new ServerResponse(), {}))).toBe(false)
      expect(isRuntimeResponse({ status: 401 })).toBe(false)
    })
  })
})
