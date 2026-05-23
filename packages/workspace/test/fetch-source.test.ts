import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace, registerWorkspace, source, useWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/registry.ts"

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  })
}

function textResponse(value: string) {
  return new Response(value, {
    headers: { "content-type": "text/plain" },
    status: 200,
  })
}

afterEach(() => {
  resetWorkspaceRegistry()
  vi.restoreAllMocks()
})

describe("fetch sources", () => {
  it("exports one live JSON source without writing to the store on read", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ignored: true, status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ ignored: true, status: "next" }))

    registerWorkspace("fetch-json", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: source.fetch({
          schema: {
            "~standard": {
              validate(input) {
                return { value: input as { ignored: boolean, status: string } }
              },
            },
          },
          transform: data => ({ status: data.status }),
          url: "https://status.example.com/api/summary",
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("fetch-json")
    await workspace.sync()

    await expect(workspace.stat("api/summary.json")).resolves.toMatchObject({ path: "api/summary.json", type: "file" })
    await expect(workspace.list("api")).resolves.toEqual([
      expect.objectContaining({ path: "api/summary.json", type: "file" }),
    ])
    await expect(workspace.readFile("api/summary.json")).resolves.toBe(JSON.stringify({ status: "ok" }, null, 2))
    await expect(workspace.readFile("api/summary.json")).resolves.toBe(JSON.stringify({ status: "next" }, null, 2))
    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("supports text, POST request factories, and explicit paths", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("healthy"))

    registerWorkspace("fetch-text", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: source.fetch({
          method: "POST",
          path: "external/status/health.txt",
          request: () => ({
            body: { scope: "all" },
            headers: { authorization: "Bearer secret" },
          }),
          responseType: "text",
          url: "https://status.example.com/query",
        }),
      },
    }))

    const workspace = useWorkspace("fetch-text")

    await expect(workspace.fs.readFile("external/status/health.txt")).resolves.toBe("healthy")
    expect(request).toHaveBeenCalledWith("https://status.example.com/query", expect.objectContaining({
      body: JSON.stringify({ scope: "all" }),
      method: "POST",
    }))
  })

  it("accepts HEAD requests and rejects unsupported response types", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(""))
    registerWorkspace("fetch-head", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        ping: source.fetch({
          method: "HEAD",
          path: "external/status/ping.txt",
          responseType: "text",
          url: "https://status.example.com/ping",
        }),
      },
    }))

    const workspace = useWorkspace("fetch-head")

    await expect(workspace.fs.readFile("external/status/ping.txt")).resolves.toBe("")
    expect(request).toHaveBeenCalledWith("https://status.example.com/ping", expect.objectContaining({ method: "HEAD" }))
    expect(() => source.fetch({
      responseType: "arrayBuffer" as never,
      url: "https://status.example.com/image",
    })).toThrow("responseType")
  })

  it("requires explicit paths for query URLs and keeps source paths read-only", async () => {
    expect(() => source.fetch({
      url: "https://status.example.com/api/summary?region=eu",
    })).toThrow("explicit path")

    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }))
    registerWorkspace("fetch-readonly", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: source.fetch({
          path: "status/eu.json",
          url: "https://status.example.com/api/summary?region=eu",
        }),
      },
    }))

    const workspace = useWorkspace("fetch-readonly", { allowWrite: true })

    await expect(workspace.fs.writeFile("status/eu.json", "nope")).rejects.toThrow("read-only")
  })

  it("materializes live fetch sources only when explicitly requested", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ready" }))
    registerWorkspace("fetch-materialize", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: source.fetch({
          path: "status/summary.json",
          url: "https://status.example.com/api/summary",
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("fetch-materialize")
    await workspace.sync()

    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })
    await workspace.materializeSources?.({ sources: ["status"] })
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "status/summary.json", type: "added" })]),
    })
  })
})
