import * as vm from "node:vm"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Response as ForeignResponse } from "undici"
import { createRequire } from "node:module"

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
    const foreignRoute = vm.runInNewContext("({ route: '/private', authorize: () => true })") as never
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

  it("rejects consumed same-realm authorization responses", async () => {
    const response = new Response("consumed", { status: 409 })
    await response.text()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response as never }] },
    }))
    const result = await handler(new Request("https://app.example/"))
    expect(result?.status).toBe(403)
  })

  it("normalizes branded authorization responses from another realm", async () => {
    // Node VM contexts have no fetch globals. Evaluate Node's own bundled fetch
    // implementation in the context so its Response has a distinct native brand.
    const natives = (process as unknown as { binding(name: string): Record<string, string> }).binding("natives")
    const foreignResponse = runInNewContext(`${natives["internal/deps/undici/undici"]};
      new module.exports.Response("Policy rejected", {
        status: 409,
        headers: { "x-policy": "rejected", "set-cookie": "policy=denied" },
      })`, {
      module: { exports: {} }, require: createRequire(import.meta.url),
      process, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
      ReadableStream, TransformStream, AbortController, AbortSignal, DOMException,
      Blob, File, MessagePort, Event, EventTarget, performance, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    })
    expect(foreignResponse).not.toBeInstanceOf(Response)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    expect(response).toBeInstanceOf(Response)
    expect(response?.status).toBe(409)
    expect(response?.headers.get("x-policy")).toBe("rejected")
    expect(response?.headers.getSetCookie()).toEqual(["policy=denied"])
    const headers: string[] = []
    response?.headers.forEach((_value, key) => headers.push(key))
    expect(headers).toContain("x-policy")
    const reader = response!.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("Policy rejected")
    expect((await reader.read()).done).toBe(true)
    await expect(response?.text()).resolves.toBe("Policy rejected")
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
      access: { routes: [{ route: "/**", authorize: () => spoof }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("rejects authorization responses with an own throwing header iterator", async () => {
    const response = new Response("Policy rejected", { status: 409 })
    Object.defineProperty(response.headers, "forEach", {
      configurable: true,
      value: () => { throw new Error("headers unavailable") },
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
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

  it.each([
    { body: null, headers: { get: () => null } },
    { body: { getReader: () => ({}) }, headers: new Headers() },
    { body: { getReader: () => ({ releaseLock() {} }) }, headers: new Headers() },
    { body: { getReader: () => ({ read: () => Promise.resolve({ done: true }), releaseLock() {} }) }, headers: new Headers() },
    { body: { tee: () => [{ getReader: () => ({ read: () => Promise.resolve({ done: true }), releaseLock() {} }) }, new ReadableStream()] }, headers: new Headers() },
    { body: { tee: () => [new ReadableStream(), {}] }, headers: new Headers() },
  ])("rejects forged response-like authorization results: %j", async (transport) => {
    const forgedResponse = {
      ...transport,
      status: 409,
      statusText: "Conflict",
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => forgedResponse as never }] },
    }))

    expect((await handler(new Request("https://app.example/")))?.status).toBe(403)
  })

  it("rejects inherited forged stream methods with accessor-backed response fields", async () => {
    const streamPrototype = {
      tee() {
        return [
          { getReader: () => ({ read: () => Promise.resolve({ done: true }), releaseLock() {} }) },
          { getReader: () => ({ read: () => Promise.resolve({ done: true }), releaseLock() {} }) },
        ]
      },
    }
    const forgedBody = Object.create(streamPrototype)
    const forgedResponse = Object.create({
      get status() { return 409 },
      get statusText() { return "Conflict" },
      get headers() { return new Headers() },
      get body() { return forgedBody },
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => forgedResponse as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))?.status).toBe(403)
  })

  it("rejects an inherited forged arrayBuffer response method", async () => {
    const forgedResponse = Object.create({
      get status() { return 409 },
      get statusText() { return "Conflict" },
      get headers() { return new Headers() },
      get body() { return null },
      arrayBuffer() { return new TextEncoder().encode("forged").buffer },
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => forgedResponse as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))?.status).toBe(403)
  })

  it("rejects response-like results without a body accessor", async () => {
    const forgedResponse = Object.create({
      get status() { return 409 },
      get statusText() { return "Conflict" },
      get headers() { return new Headers() },
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => forgedResponse as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it.each(["getPrototypeOf", "getOwnPropertyDescriptor"] as const)("rejects a response when %s reflection throws", async operation => {
    const prototype = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error("reflection failed") },
    })
    const candidate = new Proxy({}, {
      getPrototypeOf: () => {
        if (operation === "getPrototypeOf") throw new Error("reflection failed")
        return prototype
      },
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => candidate as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
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

  it("rejects objects that spoof the Response shape", async () => {
    const foreignResponse = vm.runInNewContext(`new (class {
      get status() { return 409 }
      get statusText() { return "Conflict" }
      get headers() { return { get() { return null } } }
      get body() { return null }
      get [Symbol.toStringTag]() { return "Response" }
    })()`)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))
    const result = await handler(new Request("https://app.example/"))
    expect(result?.status).toBe(403)
  })

  it("rejects a forged Response-named prototype with valid headers", async () => {
    const forgedResponse = vm.runInNewContext(`new (class Response {
      get status() { return 409 }
      get statusText() { return "Conflict" }
      get headers() { return new Headers({ "x-policy": "forged" }) }
      get body() { return null }
    })()`, { Headers })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => forgedResponse as never }] },
    }))

    const result = await handler(new Request("https://app.example/"))
    expect(result?.status).toBe(403)
    expect(result?.headers.has("x-policy")).toBe(false)
  })

  it("normalizes genuine responses with shadowed accessors into local responses", async () => {
    const response = new Response("Policy rejected", { status: 409, headers: { "x-policy": "rejected" } })
    Object.defineProperty(response, "status", { get: () => 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))

    const result = await handler(new Request("https://app.example/"))
    expect(result).toBeInstanceOf(Response)
    expect(result).not.toBe(response)
    expect(result?.status).toBe(409)
    expect(result?.headers.get("x-policy")).toBe("rejected")
    expect(await result?.text()).toBe("Policy rejected")
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
