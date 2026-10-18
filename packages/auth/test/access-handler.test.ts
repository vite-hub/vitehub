import { runInNewContext } from "node:vm"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Response as ForeignResponse } from "undici"

import { defineAuth } from "../src/index.ts"
import { createAuthAccessHandler } from "../src/server.ts"

const provider = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
  handler: vi.fn(),
}))

vi.mock("better-auth", () => ({ betterAuth: provider.betterAuth }))

const session = { session: { id: "session" }, user: { id: "user" } }

describe("Auth access handlers", () => {
  beforeEach(() => {
    provider.betterAuth.mockReset().mockReturnValue({
      api: { getSession: provider.getSession },
      handler: provider.handler,
    })
    provider.getSession.mockReset().mockResolvedValue(session)
    provider.handler.mockReset()
  })

  it.each(["web", "host"] as const)("matches exact, recursive and method rules for %s requests", async (adapter) => {
    const authorize = vi.fn(() => true)
    const definition = defineAuth({ access: { routes: [
      { route: "/private", authorize },
      { route: "/admin/**", method: "post", authorize },
      { route: "/patch", method: "PATCH", authorize },
    ] } })
    const handler = createAuthAccessHandler([
      { route: "/private", authorize: true },
      { route: "/admin/**", method: "post", authorize: true },
      { route: "/patch", method: "PATCH", authorize: true },
    ], definition)

    for (const [path, method, matches] of [
      ["/private?next=/public", "GET", true],
      ["/private/child", "GET", false],
      ["/private-other", "GET", false],
      ["/admin", "POST", true],
      ["/admin/users", "POST", true],
      ["/admin/users", "GET", false],
      ["/administrator", "POST", false],
      ["/patch", "patch", true],
    ] as const) {
      authorize.mockClear()
      provider.getSession.mockClear()
      const request = new Request(`https://app.example${path}`, { method })
      await expect(handler(adapter === "host" ? { req: request } : request)).resolves.toBeUndefined()
      expect(authorize).toHaveBeenCalledTimes(matches ? 1 : 0)
      expect(provider.getSession).toHaveBeenCalledTimes(matches ? 1 : 0)
      if (matches) expect(authorize).toHaveBeenCalledWith({ request, ...session })
    }
  })

  it("runs authorize callbacks on routes from another JavaScript realm", async () => {
    const foreignRoute = runInNewContext("({ route: '/private', authorize: () => true })") as never
    const handler = createAuthAccessHandler([{ route: "/private", authorize: true }], defineAuth({
      access: { routes: [foreignRoute] },
    }))

    await expect(handler(new Request("https://app.example/private"))).resolves.toBeUndefined()
  })

  it("does not resolve Auth for unmatched requests", async () => {
    const handler = createAuthAccessHandler([{ route: "/private/**" }])
    await expect(handler(new Request("https://app.example/public"))).resolves.toBeUndefined()
    expect(provider.betterAuth).not.toHaveBeenCalled()
  })

  it("requires every overlapping authorization rule using one Definition snapshot", async () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => false)
    const resolve = vi.fn(() => ({ access: { routes: [
      { route: "/admin/**", authorize: first },
      { route: "/admin/users", authorize: second },
    ] } }))
    const handler = createAuthAccessHandler([
      { route: "/admin/**", authorize: true },
      { route: "/admin/users", authorize: true },
    ], defineAuth(resolve))

    expect((await handler(new Request("https://app.example/admin/users")))?.status).toBe(403)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledOnce()
    expect(provider.getSession).toHaveBeenCalledOnce()
  })

  it("fails closed when a discovered authorize callback is absent at runtime", async () => {
    const handler = createAuthAccessHandler([{ route: "/admin/**", authorize: true }], defineAuth(() => ({
      access: { routes: ["/admin/**"] },
    })))
    expect((await handler(new Request("https://app.example/admin/users")))?.status).toBe(403)
  })

  it("preserves missing runtime route diagnostics", async () => {
    const handler = createAuthAccessHandler([{ route: "/admin/**", authorize: true }], defineAuth(() => ({
      access: { routes: [] },
    })))
    await expect(handler(new Request("https://app.example/admin/users"))).rejects.toMatchObject({ code: "AUTH_R0008" })
  })

  it("returns custom authorization responses unchanged", async () => {
    const response = new Response("Policy rejected", { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))
    await expect(handler(new Request("https://app.example/"))).resolves.toBe(response)
  })

  it("normalizes a local Response proxy with unstable ordinary reads", async () => {
    const source = new Response("Policy rejected", { status: 409 })
    let headerReads = 0
    const candidate = new Proxy(source, {
      get(target, key) {
        if (key === "headers" && ++headerReads > 1) throw new Error("unstable headers")
        return Reflect.get(target, key, target)
      },
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => candidate }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response).not.toBe(candidate)
    expect(response?.status).toBe(409)
    expect(() => response?.headers.forEach(() => {})).not.toThrow()
    await expect(response?.text()).resolves.toBe("Policy rejected")
    expect(headerReads).toBe(1)
  })

  it("normalizes authorization responses from another runtime", async () => {
    const foreignResponse = new ForeignResponse("Policy rejected", { status: 409 })
    expect(foreignResponse).not.toBeInstanceOf(Response)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    expect(response).toBeInstanceOf(Response)
    expect(response?.status).toBe(409)
    await expect(response?.text()).resolves.toBe("Policy rejected")
  })


  it("rejects consumed foreign authorization responses", async () => {
    const foreignResponse = new ForeignResponse("Policy rejected", { status: 409 })
    await foreignResponse.text()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it.each([["local", Response], ["foreign", ForeignResponse]] as const)("preserves authorization responses without getSetCookie from the %s runtime", async (_runtime, ResponseConstructor) => {
    const response = new ResponseConstructor("Policy rejected", { status: 409 })
    Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response as never }] },
    }))

    const result = await handler(new Request("https://app.example/"))
    expect(result?.status).toBe(409)
    await expect(result?.text()).resolves.toBe("Policy rejected")
    if (_runtime === "local") expect(result).toBe(response)
    else expect(result).toBeInstanceOf(Response)
  })

  it.each([["local", Response], ["foreign", ForeignResponse]] as const)("rejects unbranded objects with a Response prototype from the %s runtime", async (_runtime, ResponseConstructor) => {
    const spoof = Object.create(ResponseConstructor.prototype) as never
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => spoof as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("rejects response-shaped authorization spoofs", async () => {
    const spoof = {
      status: 409,
      statusText: "Conflict",
      headers: { get: () => null, getSetCookie: () => [], forEach: () => {} },
      body: null,
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => spoof as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("rejects a forged Response prototype without reading its getters", async () => {
    const sourceBody = new Response("Policy rejected").body
    const headers = vi.fn()
      .mockReturnValueOnce(new Headers({ "x-policy": "reject" }))
      .mockImplementation(() => { throw new Error("unstable headers") })
    const body = vi.fn()
      .mockReturnValueOnce(sourceBody)
      .mockImplementation(() => { throw new Error("unstable body") })
    const prototype = Object.defineProperties({}, {
      constructor: { value: function Response() {} },
      [Symbol.toStringTag]: { value: "Response" },
      status: { get: () => 409 },
      statusText: { get: () => "Conflict" },
      headers: { get: headers },
      body: { get: body },
    })
    const candidate = Object.create(prototype)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => candidate }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(403)
    expect(headers).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it("preserves foreign status, body, and separate Set-Cookie headers", async () => {
    const foreign = new ForeignResponse("Policy rejected", {
      status: 409,
      statusText: "Policy conflict",
      headers: [["set-cookie", "first=1"], ["set-cookie", "second=2"], ["x-policy", "reject"]],
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(409)
    expect(response?.statusText).toBe("Policy conflict")
    expect(response?.headers.get("x-policy")).toBe("reject")
    expect(response?.headers.getSetCookie()).toEqual(["first=1", "second=2"])
    await expect(response?.text()).resolves.toBe("Policy rejected")
  })

  it("rejects foreign responses with combined Set-Cookie headers", async () => {
    const foreign = new ForeignResponse("Policy rejected", {
      status: 409,
      headers: { "set-cookie": "first=1, second=2" },
    })
    Object.defineProperty(foreign.headers, "getSetCookie", { value: undefined })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("preserves one foreign Set-Cookie header without getSetCookie", async () => {
    const foreign = new ForeignResponse("Policy rejected", {
      status: 409,
      headers: { "set-cookie": "session=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/" },
    })
    Object.defineProperty(foreign.headers, "getSetCookie", { value: undefined })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(409)
    expect(response?.headers.get("set-cookie")).toBe("session=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/")
  })

  it("preserves commas in a single cookie extension without getSetCookie", async () => {
    const foreign = new ForeignResponse(null, {
      status: 302,
      headers: { "set-cookie": "session=one; Extension=alpha, beta=gamma" },
    })
    Object.defineProperty(foreign.headers, "getSetCookie", { value: undefined })

    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))

    expect(response?.headers.get("set-cookie")).toBe("session=one; Extension=alpha, beta=gamma")
  })

  it.each(["read", "cancel"] as const)("preserves a foreign stream with a different reader method on %s", async action => {

    const cancel = vi.fn()
    const body: ReadableStream<Uint8Array> = runInNewContext(`
      new (class extends ReadableStream {
        getReader(...args) { return super.getReader(...args) }
      })({
        start(controller) { controller.enqueue(bytes) },
        cancel,
      })
    `, { ReadableStream, bytes: new TextEncoder().encode("Policy rejected"), cancel })
    expect(body.getReader).not.toBe(ReadableStream.prototype.getReader)
    const foreign = new ForeignResponse(body, {
      status: 409,
      headers: { "x-policy": "reject" },
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(409)
    expect(response?.headers.get("x-policy")).toBe("reject")
    if (action === "read") {
      const reader = response!.body!.getReader()
      expect(await reader.read()).toEqual({ done: false, value: new TextEncoder().encode("Policy rejected") })
      await reader.cancel()
    }
    else {
      await response?.body?.cancel("client disconnected")
      expect(cancel).toHaveBeenCalledWith("client disconnected")
    }
  })

  it("preserves a foreign stream subclass inheriting its native reader method", async () => {
    const body = new (class extends ReadableStream<Uint8Array> {})({
      start(controller) { controller.enqueue(new TextEncoder().encode("Policy rejected")) },
    })
    const foreign = new ForeignResponse(body, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(409)
    await expect(response?.text()).resolves.toBe("Policy rejected")
  })

  it("rejects a body carrier that would be stringified instead of streamed", async () => {
    const foreign = new ForeignResponse(null, { status: 409 })
    Object.defineProperty(foreign, "body", { value: { locked: false, getReader() {} } })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("forwards cancellation to the foreign response body", async () => {
    const cancel = vi.fn()
    const source = new ReadableStream({ cancel }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    expect(source.locked).toBe(false)
    await response?.body?.cancel("client disconnected")
    expect(source.locked).toBe(false)

    expect(cancel).toHaveBeenCalledWith("client disconnected")
  })

  it("keeps the byte probe valid when the Uint8Array prototype chain is tampered with", async () => {
    const originalPrototype = Object.getPrototypeOf(Uint8Array.prototype)
    Object.setPrototypeOf(Uint8Array.prototype, {
      [Symbol.toStringTag]: "Uint8Array",
    })
    try {
      const foreign = new ForeignResponse(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([65]))
          controller.close()
        },
      }), { status: 409 })
      const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
        access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
      }))

      const response = await handler(new Request("https://app.example/"))
      expect(response?.status).toBe(409)
      await expect(response?.text()).resolves.toBe("A")
    }
    finally {
      Object.setPrototypeOf(Uint8Array.prototype, originalPrototype)
    }
  })

  it("bridges native stream state across distinct inherited reader methods", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([65, 66]))
        controller.close()
      },
    })
    const overriddenReader = vi.fn(() => { throw new Error("must not call supplied reader") })
    Object.setPrototypeOf(source, Object.create(ReadableStream.prototype, {
      getReader: { value: overriddenReader },
    }))
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.body?.getReader).toBe(ReadableStream.prototype.getReader)
    await expect(response?.text()).resolves.toBe("AB")
    expect(overriddenReader).not.toHaveBeenCalled()
    expect(source.locked).toBe(false)
  })

  it("keeps the normalized body idle until consumption", async () => {
    const pull = vi.fn(controller => {
      controller.enqueue(new Uint8Array([65]))
      controller.close()
    })
    const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(pull).not.toHaveBeenCalled()
    expect(source.locked).toBe(false)
    await expect(response?.text()).resolves.toBe("A")
    expect(pull).toHaveBeenCalledOnce()
    expect(source.locked).toBe(false)
  })

  it("forwards source errors and releases the native reader", async () => {
    const error = new Error("source failed")
    const source = new ReadableStream<Uint8Array>({ pull() { throw error } }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))

    await expect(response?.body?.getReader().read()).rejects.toBe(error)
    expect(source.locked).toBe(false)
  })

  it("forwards cancellation while a native read is pending and releases ownership", async () => {
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))
    const reader = response!.body!.getReader()
    const pending = reader.read()

    await reader.cancel("client disconnected")

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(cancel).toHaveBeenCalledWith("client disconnected")
    expect(source.locked).toBe(false)
  })

  it("releases the native reader when source cancellation rejects", async () => {
    const error = new Error("cancel failed")
    const source = new ReadableStream<Uint8Array>({ cancel() { throw error } }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))

    await expect(response?.body?.cancel("client disconnected")).rejects.toBe(error)
    expect(source.locked).toBe(false)
  })

  it("rejects invalid response construction before locking the source body", async () => {
    const source = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })
    const foreign = new ForeignResponse(null, { status: 204 })
    Object.defineProperty(foreign, "body", { value: source })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    expect(source.locked).toBe(false)
  })

  it("rejects an own body reader override without invoking it", async () => {
    const foreign = new ForeignResponse("Policy rejected", { status: 409 })
    const getReader = vi.fn(() => { throw new Error("must not call own reader") })
    Object.defineProperty(foreign.body, "getReader", { value: getReader })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    expect(getReader).not.toHaveBeenCalled()
  })

  it.each([["local", Response], ["foreign", ForeignResponse]] as const)("preserves status-zero error semantics from the %s runtime", async (_runtime, ResponseConstructor) => {
    const source = ResponseConstructor.error()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => source as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response).toBeInstanceOf(Response)
    expect(response).toBe(source)
    expect(() => response!.headers.getSetCookie()).not.toThrow()
    expect(() => response!.headers.forEach(() => {})).not.toThrow()
  })

  it("fails closed for a response spoof with an unusable body", async () => {
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => ({
        [Symbol.toStringTag]: "Response",
        status: 409,
        statusText: "Conflict",
        headers: {},
        body: {},
      }) as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))?.status).toBe(403)
  })

  it("rejects a response spoof with a forged stream body", async () => {
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => ({
        [Symbol.toStringTag]: "Response",
        status: 409,
        statusText: "Conflict",
        headers: new Headers(),
        body: { locked: false, getReader: () => ({}) },
      }) as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))?.status).toBe(403)
  })

  it("does not coerce malformed authorization bodies before stream validation", async () => {
    const toPrimitive = vi.fn(() => "malicious body")
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => ({
        [Symbol.toStringTag]: "Response",
        status: 409,
        statusText: "Conflict",
        headers: new Headers(),
        body: { [Symbol.toPrimitive]: toPrimitive },
      }) as never }] },
    }))

    expect((await handler(new Request("https://app.example/")))?.status).toBe(403)
    expect(toPrimitive).not.toHaveBeenCalled()
  })

  it("rejects a foreign response with a prototype-level body reader override", async () => {
    const source = new ForeignResponse("Policy rejected", { status: 409 })
    const prototype = Object.getPrototypeOf(source.body!)
    const original = Object.getOwnPropertyDescriptor(prototype, "getReader")
    Object.defineProperty(prototype, "getReader", { value: () => { throw new Error("unstable reader") } })
    try {
      const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
        access: { routes: [{ route: "/**", authorize: () => source as never }] },
      }))

      await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    }
    finally {
      if (original) Object.defineProperty(prototype, "getReader", original)
    }
  })

  it("rejects a foreign response with an unrelated native prototype reader", async () => {
    const source = new ForeignResponse("Policy rejected", { status: 409 })
    const prototype = Object.getPrototypeOf(source.body!)
    const original = Object.getOwnPropertyDescriptor(prototype, "getReader")
    Object.defineProperty(prototype, "getReader", { value: Array.prototype.values })
    try {
      const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
        access: { routes: [{ route: "/**", authorize: () => source as never }] },
      }))

      await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    }
    finally {
      if (original) Object.defineProperty(prototype, "getReader", original)
    }
  })

  it("rejects a foreign response with a reader-shaped prototype override", async () => {
    const source = new ForeignResponse("Policy rejected", { status: 409 })
    const prototype = Object.getPrototypeOf(source.body!)
    const original = Object.getOwnPropertyDescriptor(prototype, "getReader")
    Object.defineProperty(prototype, "getReader", {
      value: () => ({
        read: () => Promise.resolve({ done: true, value: undefined }),
        cancel: () => Promise.resolve(),
        releaseLock: () => {},
      }),
    })
    try {
      const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
        access: { routes: [{ route: "/**", authorize: () => source as never }] },
      }))

      await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    }
    finally {
      if (original) Object.defineProperty(prototype, "getReader", original)
    }
  })

  it.each(["response", "headers"] as const)("rejects a %s carrier whose descriptor reflection throws", async carrier => {
    const source = new Response(null, { status: 409 })
    const forEach = source.headers.forEach.bind(source.headers)
    const headers = new Proxy({}, {
      get: (_target, key) => key === "forEach" ? forEach : undefined,
      getOwnPropertyDescriptor: () => { throw new Error("descriptor reflection failed") },
    })
    const candidate = carrier === "response" ? new Proxy(source, {
      get: (target, key) => Reflect.get(target, key, target),
      getOwnPropertyDescriptor: () => { throw new Error("descriptor reflection failed") },
    }) : source
    if (carrier === "headers") Object.defineProperty(source, "headers", { value: headers })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => candidate }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("rejects a tagged custom prototype with stateful response getters", async () => {
    const headers = vi.fn()
      .mockReturnValueOnce(new Headers({ "x-policy": "reject" }))
      .mockImplementation(() => { throw new Error("unstable headers") })
    const prototype = Object.defineProperties({}, {
      [Symbol.toStringTag]: { value: "Response" },
      status: { get: () => 409 },
      statusText: { get: () => "Conflict" },
      headers: { get: headers },
      body: { get: () => null },
    })
    const spoof = Object.create(prototype)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => spoof }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(403)
    expect(() => response?.headers.forEach(() => {})).not.toThrow()
  })

  it.each(["consumed", "locked"] as const)("preserves a native authorization Response with a %s body unchanged", async state => {
    const response = new Response("Policy rejected", { status: 409, headers: { "x-policy": "custom" } })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    if (state === "consumed") await response.text()
    else reader = response.body!.getReader()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))
    try {
      await expect(handler(new Request("https://app.example/"))).resolves.toBe(response)
      expect(response.status).toBe(409)
      expect(response.headers.get("x-policy")).toBe("custom")
    }
    finally {
      reader?.releaseLock()
    }
  })


  it.each([false, true])("checks foreign body state when bodyUsed is shadowed (consumed: %s)", async (consumed) => {
    const source = new ForeignResponse("Policy rejected", { status: 409 })
    if (consumed) await source.text()
    Object.defineProperty(source, "bodyUsed", { value: false })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => source as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    expect(response?.status).toBe(consumed ? 403 : 409)
    if (!consumed) await expect(response?.text()).resolves.toBe("Policy rejected")
  })

  it("rejects an already-consumed body from the foreign runtime", async () => {
    const ResponseConstructor = ForeignResponse
    const source = new ResponseConstructor("Policy rejected", { status: 409 })
    const reader = source.body!.getReader()
    await reader.read()
    await reader.read()
    reader.releaseLock()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => source as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("rejects a foreign response whose body is locked", async () => {
    const response = new ForeignResponse("Policy rejected", { status: 409 })
    const reader = response.body!.getReader()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response as never }] },
    }))
    try {
      await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    }
    finally {
      reader.releaseLock()
    }
  })

  it("snapshots a serializable Response-shaped prototype without rereading its getters", async () => {
    const sourceBody = new Response("Policy rejected").body
    const headers = vi.fn()
      .mockReturnValueOnce(new Headers({ "x-policy": "reject" }))
      .mockImplementation(() => { throw new Error("unstable headers") })
    const body = vi.fn()
      .mockReturnValueOnce(sourceBody)
      .mockImplementation(() => { throw new Error("unstable body") })
    const prototype = Object.defineProperties({}, {
      constructor: { value: function Response() {} },
      [Symbol.toStringTag]: { value: "Response" },
      status: { get: () => 409 },
      statusText: { get: () => "Conflict" },
      headers: { get: headers },
      body: { get: body },

      bodyUsed: { get: () => false },
    })
    const candidate = Object.create(prototype)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => candidate }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response).toBeInstanceOf(Response)
    expect(response).not.toBe(candidate)
    expect(response?.status).toBe(409)
    expect(response?.statusText).toBe("Conflict")
    expect(response?.headers.get("x-policy")).toBe("reject")
    await expect(response?.text()).resolves.toBe("Policy rejected")
    expect(headers).toHaveBeenCalledTimes(1)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it("preserves foreign status, body, and separate Set-Cookie headers", async () => {
    const foreign = new ForeignResponse("Policy rejected", {
      status: 409,
      statusText: "Policy conflict",
      headers: [["set-cookie", "first=1"], ["set-cookie", "second=2"], ["x-policy", "reject"]],
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(409)
    expect(response?.statusText).toBe("Policy conflict")
    expect(response?.headers.get("x-policy")).toBe("reject")
    expect(response?.headers.getSetCookie()).toEqual(["first=1", "second=2"])
    await expect(response?.text()).resolves.toBe("Policy rejected")
  })

  it("forwards cancellation to the foreign response body", async () => {
    const cancel = vi.fn()
    const foreign = new ForeignResponse(new ReadableStream({ cancel }), { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    await response?.body?.cancel("client disconnected")

    expect(cancel).toHaveBeenCalledWith("client disconnected")
  })

  it("bridges native stream state across distinct inherited reader methods", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([65, 66]))
        controller.close()
      },
    })
    const overriddenReader = vi.fn(() => { throw new Error("must not call supplied reader") })
    Object.setPrototypeOf(source, Object.create(ReadableStream.prototype, {
      getReader: { value: overriddenReader },
    }))
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.body?.getReader).toBe(ReadableStream.prototype.getReader)
    await expect(response?.text()).resolves.toBe("AB")
    expect(overriddenReader).not.toHaveBeenCalled()
    expect(source.locked).toBe(false)
  })

  it("keeps the normalized body idle until consumption", async () => {
    const pull = vi.fn(controller => {
      controller.enqueue(new Uint8Array([65]))
      controller.close()
    })
    const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(pull).not.toHaveBeenCalled()
    await expect(response?.text()).resolves.toBe("A")
    expect(pull).toHaveBeenCalledOnce()
    expect(source.locked).toBe(false)
  })

  it("forwards source errors and releases the native reader", async () => {
    const error = new Error("source failed")
    const source = new ReadableStream<Uint8Array>({ pull() { throw error } }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))

    await expect(response?.body?.getReader().read()).rejects.toBe(error)
    expect(source.locked).toBe(false)
  })

  it("forwards cancellation while a native read is pending and releases ownership", async () => {
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))
    const reader = response!.body!.getReader()
    const pending = reader.read()

    await reader.cancel("client disconnected")

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(cancel).toHaveBeenCalledWith("client disconnected")
    expect(source.locked).toBe(false)
  })

  it("releases the native reader when source cancellation rejects", async () => {
    const error = new Error("cancel failed")
    const source = new ReadableStream<Uint8Array>({ cancel() { throw error } }, { highWaterMark: 0 })
    const foreign = new ForeignResponse(source, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))

    await expect(response?.body?.cancel("client disconnected")).rejects.toBe(error)
    expect(source.locked).toBe(false)
  })

  it("rejects invalid response construction before locking the source body", async () => {
    const source = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })
    const foreign = new ForeignResponse(null, { status: 204 })
    Object.defineProperty(foreign, "body", { value: source })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    expect(source.locked).toBe(false)
  })

  it("rejects an own body reader override without invoking it", async () => {
    const foreign = new ForeignResponse("Policy rejected", { status: 409 })
    const getReader = vi.fn(() => { throw new Error("must not call own reader") })
    Object.defineProperty(foreign.body, "getReader", { value: getReader })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    expect(getReader).not.toHaveBeenCalled()
  })

  it.each([["local", Response], ["foreign", ForeignResponse]] as const)("preserves status-zero error semantics from the %s runtime", async (_runtime, ResponseConstructor) => {
    const source = ResponseConstructor.error()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => source as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response).toBeInstanceOf(Response)
    expect(response?.status).toBe(0)
    expect(response?.type).toBe("error")
    expect(response?.body).toBeNull()
    if (_runtime === "local") expect(response).toBe(source)
  })

  it("rejects a foreign response with an overridden body reader", async () => {
    const source = new ForeignResponse("Policy rejected", { status: 409 })
    const getReader = vi.fn(() => { throw new Error("unstable reader") })
    Object.defineProperty(source.body, "getReader", { get: getReader })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => source as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    expect(getReader).not.toHaveBeenCalled()
  })

  it("starts provider sign-in only for matched unauthenticated HTML requests", async () => {
    provider.getSession.mockResolvedValue(null)
    provider.handler.mockResolvedValue(Response.json({ url: "https://provider.example/sign-in" }))
    const authorize = vi.fn(() => true)
    const handler = createAuthAccessHandler([{ route: "/private", authorize: true }], defineAuth({
      access: {
        routes: [{ route: "/private", authorize }],
        signIn: { provider: "github", callbackURL: "/private" },
      },
    }))
    const response = await handler(new Request("https://app.example/private", { headers: { accept: "text/html" } }))
    expect(response?.status).toBe(302)
    expect(response?.headers.get("location")).toBe("https://provider.example/sign-in")
    expect(authorize).not.toHaveBeenCalled()

    provider.handler.mockClear()
    expect((await handler(new Request("https://app.example/private")))?.status).toBe(401)
    expect(provider.handler).not.toHaveBeenCalled()
  })
})
