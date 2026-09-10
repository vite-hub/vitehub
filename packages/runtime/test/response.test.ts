import { describe, expect, it } from "vitest"
import { deserializeResponse, isSerializedResponse, serializeResponse } from "../src/response.ts"

describe("durable Response representation", () => {
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
  })

  it("rejects malformed records", () => {
    expect(isSerializedResponse({})).toBe(false)
    expect(() => deserializeResponse({} as never)).toThrow(TypeError)
  })
})
