import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentToolSet } from "../src/types.ts"

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
  vi.restoreAllMocks()
})

describe("fetch capability", () => {
  it("creates query tools that validate input and transform JSON responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ region: "eu", status: "ok" }))
    const { fetch } = await import("../src/capabilities.ts")
    const capability = fetch({
      tools: {
        checkRegionStatus: {
          description: "Check region status.",
          inputSchema: {
            "~standard": {
              jsonSchema: {
                input: () => ({ properties: { region: { type: "string" } }, required: ["region"], type: "object" }),
                output: () => ({ properties: { region: { type: "string" } }, required: ["region"], type: "object" }),
              },
              validate(input) {
                if (!input || typeof input !== "object" || typeof (input as { region?: unknown }).region !== "string") {
                  return { issues: [{ message: "region is required" }] }
                }
                return { value: input as { region: string } }
              },
              vendor: "test",
              version: 1,
            },
          },
          request: input => ({
            query: { region: input.region },
            url: "https://status.example.com/api/region",
          }),
          schema: {
            "~standard": {
              validate(input) {
                return { value: input as { region: string, status: string } }
              },
              vendor: "test",
              version: 1,
            },
          },
          transform: data => ({ status: data.status }),
        },
      },
    })
    const tools = capability.tools as AgentToolSet

    await expect(tools.checkRegionStatus.execute?.({ region: "eu" })).resolves.toEqual({ status: "ok" })
    await expect(tools.checkRegionStatus.execute?.({})).rejects.toThrow("Invalid checkRegionStatus input")
  })

  it("supports static text fetch tools and HEAD requests", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(textResponse("healthy"))
      .mockResolvedValueOnce(textResponse(""))
    const { fetch } = await import("../src/capabilities.ts")
    const capability = fetch({
      tools: {
        health: {
          request: { url: "https://status.example.com/health" },
          responseType: "text",
        },
        ping: {
          method: "HEAD",
          responseType: "text",
          url: "https://status.example.com/ping",
        },
      },
    })
    const tools = capability.tools as AgentToolSet

    await expect(tools.health.execute?.({})).resolves.toBe("healthy")
    await expect(tools.ping.execute?.({})).resolves.toBe("")
    expect(request).toHaveBeenLastCalledWith("https://status.example.com/ping", expect.objectContaining({ method: "HEAD" }))
  })

  it("rejects unsupported fetch methods, response types, and missing urls", async () => {
    const { fetch } = await import("../src/capabilities.ts")
    const unsupported = fetch({
      tools: {
        deleteThing: {
          request: { method: "DELETE" as never, url: "https://example.com/delete" },
        },
      },
    }).tools as AgentToolSet
    const binary = fetch({
      tools: {
        image: {
          request: { url: "https://example.com/image.png" },
          responseType: "arrayBuffer" as never,
        },
      },
    }).tools as AgentToolSet
    const missingUrl = fetch({
      tools: {
        missing: {
          request: {},
        },
      },
    }).tools as AgentToolSet

    await expect(unsupported.deleteThing.execute?.({})).rejects.toThrow("not supported")
    await expect(binary.image.execute?.({})).rejects.toThrow("responseType")
    await expect(missingUrl.missing.execute?.({})).rejects.toThrow("requires a url")
  })
})
