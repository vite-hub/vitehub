import { describe, expect, it } from "vitest"
import { Response as ForeignResponse } from "../../../node_modules/.pnpm/@whatwg-node+node-fetch@0.8.6/node_modules/@whatwg-node/node-fetch/esm/index.js"

import { isResponse, registerResponseConstructor } from "../src/internal/response.ts"

describe("host Response detection", () => {
  it("accepts the Response that a server installs as the global after load, as srvx does in Nitro", () => {
    const native = globalThis.Response
    class ServerResponse {
      #init: ResponseInit | undefined
      constructor(_body?: BodyInit | null, init?: ResponseInit) {
        this.#init = init
      }

      get headers() {
        return new Headers(this.#init?.headers)
      }

      get status() {
        return this.#init?.status ?? 200
      }
    }
    globalThis.Response = ServerResponse as unknown as typeof Response
    try {
      expect(isResponse(new ServerResponse(null, { status: 204 }))).toBe(true)
      expect(isResponse(Object.create(ServerResponse.prototype))).toBe(false)
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

  it("rejects proxies around native responses through the registered fallback", () => {
    class CustomResponse extends Response {}
    registerResponseConstructor(Response)
    for (const response of [new Response("native"), new CustomResponse("subclass")]) {
      expect(isResponse(new Proxy(response, {}))).toBe(false)
    }
  })

  it("accepts registered foreign responses and their subclasses", () => {
    registerResponseConstructor(ForeignResponse)
    class CustomResponse extends ForeignResponse {}
    expect(isResponse(new ForeignResponse("foreign"))).toBe(true)
    expect(isResponse(new CustomResponse("subclass"))).toBe(true)
  })
})
