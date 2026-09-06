import { executeHttpRequest } from "../src/http-request.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("HTTP request in workerd", () => {
  it("decodes bounded text and JSON through the workerd WHATWG Response path", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("hello"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 5, url: "https://example.com/text" }, { responseType: "text" }))
      .resolves.toMatchObject({ data: "hello" })
    await expect(executeHttpRequest({ maxResponseBytes: 11, url: "https://example.com/json" }))
      .resolves.toMatchObject({ data: { ok: true } })
  })

  it("cancels a workerd response stream when decoded bytes exceed the limit", async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      cancel,
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"))
      },
    })))
    vi.stubGlobal("fetch", fetch)

    await expect(executeHttpRequest({ maxResponseBytes: 3, url: "https://example.com/large" }, { responseType: "text" }))
      .rejects.toThrow("configured 3-byte limit")
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
