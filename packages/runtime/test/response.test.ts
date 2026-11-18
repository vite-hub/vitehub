import { afterEach, describe, expect, it, vi } from "vitest"
import { Buffer as NodeBuffer } from "node:buffer"
import { runInNewContext } from "node:vm"
import { Diagnostic } from "nostics"
import { deserializeResponse, isSerializedResponse, serializeResponse, toResponse } from "../src/response.ts"
import { defineErrors, toResultError } from "../src/result.ts"

afterEach(() => vi.unstubAllGlobals())

describe("durable Response representation", () => {
  it.each([false, true])("preserves binary bodies and padding with Buffer disabled: %s", async (disableBuffer) => {
    for (const length of [0, 1, 2, 3, 32_767, 32_768, 32_769, 65_537]) {
      const source = Uint8Array.from({ length: length + 13 }, (_, index) => index % 256)
      const bytes = source.subarray(7, 7 + length)
      const response = new Response(bytes)
      if (disableBuffer) {
        // Node's Response reader needs Buffer; disable it only after reading the body.
        const read = response.arrayBuffer.bind(response)
        vi.spyOn(response, "arrayBuffer").mockImplementation(async () => {
          const body = await read()
          vi.stubGlobal("Buffer", undefined)
          return body
        })
      }
      const serialized = await serializeResponse(response)
      vi.unstubAllGlobals()
      expect(serialized.body.data).toBe(NodeBuffer.from(bytes).toString("base64"))
      expect(new Uint8Array(await deserializeResponse(serialized).arrayBuffer())).toEqual(bytes)
    }
  })

  it("accepts ArrayBuffer values created in another realm", async () => {
    const value = runInNewContext("new ArrayBuffer(3)")
    new Uint8Array(value)[0] = 0x41
    const response = toResponse(value)

    expect(response.headers.get("content-type")).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0x41, 0, 0))
  })

  it("preserves native Blob bodies", async () => {
    const blob = new Blob(["test"], { type: "text/plain" })

    const response = toResponse(blob)
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(await response.text()).toBe("test")
  })

  it("keeps spoofed and hostile Blob-shaped values on the JSON path", async () => {
    const spoof = { size: 4, type: "text/plain", arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }
    Object.defineProperty(spoof, Symbol.toStringTag, { value: "Blob" })
    const hostile = Object.defineProperty({}, Symbol.toStringTag, { get() { throw new Error("boom") } })

    expect(await toResponse(spoof).json()).toEqual({ size: 4, type: "text/plain" })
    expect(await toResponse(hostile).json()).toEqual({})
    expect(await toResponse([1, 2]).json()).toEqual([1, 2])
  })

  it("does not execute spoofed Blob methods", async () => {
    const spoof = { slice: () => spoof, stream: () => { throw new Error("spoof") }, type: "text/plain" }
    expect(await toResponse(spoof).json()).toEqual({ type: "text/plain" })

    const distinctPrototype = {
      slice(this: object) { return Object.create(Object.getPrototypeOf(this), { type: { value: "text/plain" } }) },
      stream() { throw new Error("distinct spoof") },
      get size() { return 0 },
    }
    const distinct = Object.create(distinctPrototype, { type: { value: "text/plain", enumerable: true } })
    expect(await toResponse(distinct).json()).toEqual({ type: "text/plain" })
  })

  it("does not add a content type for an untyped Blob", async () => {
    const blob = new Blob(["test"])
    const response = toResponse(blob)

    expect(response.headers.has("content-type")).toBe(false)
    expect(await response.text()).toBe("test")
  })

  it("normalizes a Response-shaped impostor instead of returning it", () => {
    const foreignPrototype = {
      [Symbol.toStringTag]: "Response",
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      clone() { return this },
    }
    const foreign = Object.assign(Object.create(foreignPrototype), {
      body: null, headers: { get: () => null, [Symbol.toStringTag]: "Headers" }, status: 200, statusText: "",
    }) as Response
    const normalized = toResponse(foreign)
    expect(normalized).not.toBe(foreign)
    expect(normalized.headers).toBeInstanceOf(Headers)
    expect(normalized.status).toBe(200)
  })

  it.each([204, 205, 304])("round trips a bodyless response with status %s", async (status) => {
    const restored = deserializeResponse(await serializeResponse(new Response(null, { status })))
    expect(restored.status).toBe(status)
    expect(restored.body).toBeNull()
  })

  it("round trips status, duplicate headers, and binary body", async () => {
    const original = new Response(new Uint8Array([0, 127, 255]), {
      headers: [["set-cookie", "a=1, b=2"], ["content-type", "application/octet-stream"]],
      status: 201,
      statusText: "Created",
    })
    const serialized = await serializeResponse(original)
    expect(serialized).toEqual({
      body: { isNull: false, data: "AH//", encoding: "base64", mediaType: "application/octet-stream" },
      headers: [["content-type", "application/octet-stream"], ["set-cookie", "a=1, b=2"]],
      status: 201,
      statusText: "Created",
    })
    expect(isSerializedResponse(serialized)).toBe(true)
    const restored = deserializeResponse(serialized)
    expect(restored.status).toBe(201)
    expect(restored.statusText).toBe("Created")
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array([0, 127, 255]))
  })

  it("round trips a multi-megabyte body without overflowing Base64 validation", async () => {
    const body = new Uint8Array(4 * 1024 * 1024).fill(255)
    const serialized = await serializeResponse(new Response(body))

    expect(isSerializedResponse(serialized)).toBe(true)
    const restored = new Uint8Array(await deserializeResponse(serialized).arrayBuffer())
    expect(restored.byteLength).toBe(body.byteLength)
    expect(restored.every(byte => byte === 255)).toBe(true)
    expect(isSerializedResponse({ ...serialized, body: { ...serialized.body, data: `${serialized.body.data}!` } })).toBe(false)
  })

  it.each(["", "YQ", "YQ==", "YWI", "YWI=", "YWJj", " Y\tQ\n=\r=\f"])("accepts native Base64 representation %j", async (data) => {
    const serialized = await serializeResponse(new Response(""))
    const record = { ...serialized, body: { ...serialized.body, data } }

    expect(isSerializedResponse(record)).toBe(true)
    expect(await deserializeResponse(record).text()).toBe(atob(data))
  })

  it.each(["Y", "YQ=", "YWI==", "YWJj=", "=YQ=", "YQ===", "====", "YQ-_", "YQ\u00a0=="])("rejects malformed Base64 representation %j", async (data) => {
    const serialized = await serializeResponse(new Response(""))
    const record = { ...serialized, body: { ...serialized.body, data } }

    expect(isSerializedResponse(record)).toBe(false)
    expect(() => deserializeResponse(record)).toThrowError(expect.objectContaining({ code: "RUNTIME_SERIALIZED_RESPONSE_INVALID" }))
  })

  it.each([null, new Uint8Array()])("preserves body presence for %s", async (body) => {
    const restored = deserializeResponse(await serializeResponse(new Response(body)))
    expect(restored.body === null).toBe(body === null)
    expect(await restored.text()).toBe("")
  })

  it.each(["error", "opaque", "opaqueredirect"] as const)("preserves %s responses and rejects malformed status-zero records", async (type) => {
    // Node cannot fetch opaque responses; model their observable filtered state.
    const original = Response.error()
    const url = type === "opaqueredirect" ? "https://example.com/manual-redirect" : ""
    Object.defineProperties(original, { type: { value: type }, url: { value: url } })
    const serialized = await serializeResponse(original)
    const restored = deserializeResponse(serialized)
    expect(restored.type).toBe(type)
    expect(restored.url).toBe(url)
    expect(restored.clone().url).toBe(url)
    expect(restored).toBeInstanceOf(Response)
    expect(restored.ok).toBe(false)
    expect(restored.clone().type).toBe(type)
    expect(await serializeResponse(restored.clone())).toEqual(serialized)
    expect(() => restored.headers.set("x-test", "value")).toThrow(TypeError)
    expect(restored.status).toBe(0)
    expect(restored.body).toBeNull()
    expect(isSerializedResponse({ ...serialized, type: undefined })).toBe(false)
    expect(isSerializedResponse({ ...serialized, type: "basic" })).toBe(false)
    expect(isSerializedResponse({ ...serialized, url: 42 })).toBe(false)
    expect(isSerializedResponse({ ...serialized, statusText: "OK" })).toBe(false)
    expect(isSerializedResponse({ ...serialized, body: { ...serialized.body, isNull: false } })).toBe(false)
    expect(isSerializedResponse({ ...serialized, status: 200 })).toBe(false)
    expect(isSerializedResponse({ ...serialized, headers: [["x-test", "value"]] })).toBe(false)
    expect(isSerializedResponse({ ...serialized, body: { ...serialized.body, data: "YQ==" } })).toBe(false)
    if (type !== "opaqueredirect") {
      expect(isSerializedResponse({ ...serialized, url: "https://unexpected.example" })).toBe(false)
    }
  })

  it("rejects malformed records", () => {
    expect(isSerializedResponse({})).toBe(false)
    expect(() => deserializeResponse({} as never)).toThrowError(expect.objectContaining({ code: "RUNTIME_SERIALIZED_RESPONSE_INVALID" }))
  })

  it("rejects URLs on ordinary response records", async () => {
    const serialized = await serializeResponse(new Response("ok"))
    expect(isSerializedResponse({ ...serialized, url: "https://unexpected.example" })).toBe(false)
  })

  it("rejects sparse header arrays", () => {
    const serialized = {
      body: { data: "", encoding: "base64" as const, mediaType: "text/plain" },
      headers: new Array(1),
      status: 200,
      statusText: "",
    }

    expect(isSerializedResponse(serialized)).toBe(false)
    expect(() => deserializeResponse(serialized as never)).toThrowError(expect.objectContaining({ code: "RUNTIME_SERIALIZED_RESPONSE_INVALID" }))
  })

  it("rejects response fields that the native Response constructor cannot read", async () => {
    const serialized = await serializeResponse(new Response("ok", {
      headers: { "x-test": "value" },
      statusText: "OK",
    }))

    for (const data of ["!", "YQ="]) {
      expect(isSerializedResponse({ ...serialized, body: { ...serialized.body, data } })).toBe(false)
    }
    expect(isSerializedResponse({ ...serialized, statusText: "\u0000" })).toBe(false)
    expect(isSerializedResponse({ ...serialized, headers: [["invalid name", "value"]] })).toBe(false)
    expect(isSerializedResponse({ ...serialized, headers: [["x-test", "\u0000"]] })).toBe(false)
  })

  it.each([204, 205, 304])("rejects a non-empty body for status %s", (status) => {
    const serialized = {
      body: { data: "YQ==", encoding: "base64" as const, mediaType: "text/plain" },
      headers: [],
      status,
      statusText: "",
    }
    expect(isSerializedResponse(serialized)).toBe(false)
    expect(() => deserializeResponse(serialized)).toThrowError(expect.objectContaining({ code: "RUNTIME_SERIALIZED_RESPONSE_INVALID" }))
  })

  it.each([204, 205, 304])("rejects an explicitly present empty body for status %s", (status) => {
    const serialized = {
      body: { data: "", encoding: "base64" as const, mediaType: "text/plain", isNull: false },
      headers: [],
      status,
      statusText: "",
    }
    expect(isSerializedResponse(serialized)).toBe(false)
    expect(() => deserializeResponse(serialized)).toThrowError(expect.objectContaining({ code: "RUNTIME_SERIALIZED_RESPONSE_INVALID" }))
  })

  it.each([204, 205, 304])("preserves zero-byte legacy Base64 representations for status %s", (status) => {
    for (const data of ["", " ", "\n", "\t\n\f\r "]) {
      const serialized = {
        body: { data, encoding: "base64" as const, mediaType: "text/plain" },
        headers: [],
        status,
        statusText: "",
      }
      expect(isSerializedResponse(serialized)).toBe(true)
      expect(deserializeResponse(serialized).body).toBeNull()
      expect(isSerializedResponse({ ...serialized, body: { ...serialized.body, isNull: false } })).toBe(false)
    }
  })
})

describe("toResponse with a ResultError", () => {
  it("only applies the error response contract to prepared diagnostics", async () => {
    const diagnostic = new Diagnostic({ code: "EXAMPLE_DIAGNOSTIC", why: "An ordinary diagnostic.", data: { count: 2 } })
    const response = toResponse(diagnostic)
    expect(response.status).toBe(200)
    // A plain Nostics diagnostic keeps its own serializer, which names the code `name`.
    expect(await response.json()).toMatchObject({ name: "EXAMPLE_DIAGNOSTIC", data: { count: 2 } })

    const result = toResponse(toResultError(diagnostic))
    expect(result.status).toBe(500)
    expect(await result.json()).toEqual({ code: "EXAMPLE_DIAGNOSTIC", why: "An ordinary diagnostic." })
  })

  const errors = defineErrors({
    docs: "https://vitehub.dev/docs/example",
    codes: {
      EXAMPLE_CONFLICT: { why: "Someone else saved first.", fix: "Read the record again, then save.", status: 409 },
      EXAMPLE_FAILED: { why: "The provider failed.", fix: "Try again." },
    },
  })

  it("answers the status of the code with code, why, and fix", async () => {
    const response = toResponse(errors.EXAMPLE_CONFLICT({ cause: new Error("secret provider detail") }))

    expect(response.status).toBe(409)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response.json()).toEqual({ code: "EXAMPLE_CONFLICT", why: "Someone else saved first.", fix: "Read the record again, then save." })
  })

  it("answers 500 when the code has no status", async () => {
    const response = toResponse(errors.EXAMPLE_FAILED())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: "EXAMPLE_FAILED", why: "The provider failed.", fix: "Try again." })
  })

  it("keeps a status outside 400 to 599 from the response", () => {
    expect(toResponse(Object.assign(errors.EXAMPLE_FAILED(), { status: 200 })).status).toBe(500)
  })
})
