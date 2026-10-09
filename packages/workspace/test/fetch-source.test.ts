import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace, fetch, resolveRegisteredWorkspaceDefinition, useWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { normalizeWorkspaceSources } from "../src/sources/config.ts"
import { createWorkspaceSourceRequestExecution } from "../src/sources/request-execution.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

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
  it.each(["first", "first&__proto__=second"])("preserves declared __proto__ query values %s on Source reads", async (query) => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }))
    const url = `https://status.example.com/query?__proto__=${query}`
    const view = createWorkspaceSourceView({
      name: "fetch-prototype-query",
      sources: { status: fetch({ url, workspacePath: "status.json" }) },
    }, createMemoryWorkspaceStore())

    await expect(view.readFile("status.json")).resolves.toContain("ok")
    expect(request.mock.calls[0]?.[0]).toBe(url)
  })

  it("uses __proto__ query values to distinguish declared Source requests", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }))
    const execution = createWorkspaceSourceRequestExecution({
      name: "fetch-prototype-request-match",
      sources: {
        first: fetch({ url: "https://status.example.com/query?__proto__=first" }),
        second: fetch({ url: "https://status.example.com/query?__proto__=second" }),
      },
    })!

    await expect(execution.executeSourceRequest({ method: "GET", url: "https://status.example.com/query?__proto__=second" })).resolves.toMatchObject({ status: 200 })
    expect(request.mock.calls[0]?.[0]).toBe("https://status.example.com/query?__proto__=second")
    await expect(execution.executeSourceRequest({ method: "GET", url: "https://status.example.com/query?__proto__=undeclared" })).rejects.toThrow("does not match a declared Source target")
    expect(request).toHaveBeenCalledOnce()
  })

  it("passes __proto__ query fields to a declared request schema", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }))
    const validate = vi.fn((input: unknown) => ({ value: input as Record<string, unknown> }))
    const execution = createWorkspaceSourceRequestExecution({
      name: "fetch-prototype-query-schema",
      sources: { status: fetch({
        querySchema: { "~standard": {
          validate,
          jsonSchema: { input: () => ({ type: "object" }) },
        } },
        url: "https://status.example.com/query",
      }) },
    })!
    const url = "https://status.example.com/query?__proto__=first&__proto__=second"

    await expect(execution.executeSourceRequest({ method: "GET", url })).resolves.toMatchObject({ status: 200 })
    expect(validate.mock.calls[0]?.[0]).toEqual({ ["__proto__"]: ["first", "second"] })
    expect(Object.getPrototypeOf(validate.mock.calls[0]?.[0])).toBe(Object.prototype)
    expect(request.mock.calls[0]?.[0]).toBe(url)
  })

  it("matches declared request query fields regardless of their key order", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ status: "ok" }))
    const execution = createWorkspaceSourceRequestExecution({
      name: "fetch-query-order",
      sources: { status: fetch({ url: "https://status.example.com/query?region=eu&tag=first&tag=second" }) },
    })!

    await expect(execution.executeSourceRequest({
      method: "GET",
      url: "https://status.example.com/query?tag=first&tag=second&region=eu",
    })).resolves.toMatchObject({ status: 200 })
    expect(request).toHaveBeenCalledOnce()

    await expect(execution.executeSourceRequest({
      method: "GET",
      url: "https://status.example.com/query?region=eu&tag=second&tag=first",
    })).rejects.toThrow("does not match a declared Source target")
    expect(request).toHaveBeenCalledOnce()
  })

  it("matches declared JSON body fields regardless of nested object key order", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ status: "ok" }))
    const execution = createWorkspaceSourceRequestExecution({
      name: "fetch-body-order",
      sources: { status: fetch({
        body: { filter: { region: "eu", enabled: true }, tags: ["first", "second"] },
        method: "POST",
        url: "https://status.example.com/query",
      }) },
    })!

    await expect(execution.executeSourceRequest({
      body: { tags: ["first", "second"], filter: { enabled: true, region: "eu" } },
      method: "POST",
      url: "https://status.example.com/query",
    })).resolves.toMatchObject({ status: 200 })
    expect(request).toHaveBeenCalledOnce()

    await expect(execution.executeSourceRequest({
      body: { filter: { region: "eu", enabled: true }, tags: ["second", "first"] },
      method: "POST",
      url: "https://status.example.com/query",
    })).rejects.toThrow("does not match a declared Source target")
    expect(request).toHaveBeenCalledOnce()
  })

  it("keeps distinct Unicode query keys stable when matching their order", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ status: "ok" }))
    const execution = createWorkspaceSourceRequestExecution({
      name: "fetch-unicode-query-order",
      sources: { status: fetch({
        query: { "\u00e9": "first", "e\u0301": "second" },
        url: "https://status.example.com/query",
      }) },
    })!
    const query = new URLSearchParams([["e\u0301", "second"], ["\u00e9", "first"]])

    await expect(execution.executeSourceRequest({
      method: "GET",
      url: `https://status.example.com/query?${query}`,
    })).resolves.toMatchObject({ status: 200 })
  })

  it.each([new Date("2026-01-01T00:00:00Z"), new URL("https://example.com/")])("preserves JSON serialization for a declared non-plain body %s", async (body) => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ status: "ok" }))
    const execution = createWorkspaceSourceRequestExecution({
      name: "fetch-serialized-body",
      sources: { status: fetch({ body, method: "POST", url: "https://status.example.com/query" }) },
    })!

    await expect(execution.executeSourceRequest({
      body: {},
      method: "POST",
      url: "https://status.example.com/query",
    })).rejects.toThrow("does not match a declared Source target")
    expect(request).not.toHaveBeenCalled()

    await expect(execution.executeSourceRequest({
      body: JSON.parse(JSON.stringify(body)),
      method: "POST",
      url: "https://status.example.com/query",
    })).resolves.toMatchObject({ status: 200 })
    expect(request).toHaveBeenCalledOnce()
  })

  it("identifies explicit and resolved fetch Sources by provider", async () => {
    expect(fetch({ url: "https://status.example.com/health" })).toMatchObject({ name: "fetch" })
    expect(normalizeWorkspaceSources({ status: { url: "https://status.example.com/health" } })[0]?.source).toMatchObject({ name: "fetch" })

    const source = fetch(() => ({ url: "https://status.example.com/health" }))
    expect(source).toMatchObject({ name: "fetch" })
    // SAFETY: This provider's resolver does not inspect the Source context.
    await expect(source.resolve?.({} as never)).resolves.toMatchObject({ name: "fetch" })
  })

  it("exports one live JSON source without writing to the store on read", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ignored: true, status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ ignored: true, status: "next" }))

    registerWorkspace("fetch-json", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: fetch({
          workspacePath: "api/summary.json",
          transform: (data: { ignored: boolean, status: string }) => ({ status: data.status }),
          url: "https://status.example.com/api/summary",
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("fetch-json")

    await expect(workspace.stat("api/summary.json")).resolves.toMatchObject({ path: "api/summary.json", type: "file" })
    await expect(workspace.list("api")).resolves.toEqual([
      expect.objectContaining({ path: "api/summary.json", type: "file" }),
    ])
    await expect(workspace.readFile("api/summary.json")).resolves.toBe(JSON.stringify({ status: "ok" }, null, 2))
    await expect(workspace.readFile("api/summary.json")).resolves.toBe(JSON.stringify({ status: "next" }, null, 2))
    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("preserves plain-object fetch source paths", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }))

    registerWorkspace("fetch-plain-object-path", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: {
          path: "status.json",
          url: "https://status.example.com/health",
        },
      },
    }))

    const fs = useWorkspace("fetch-plain-object-path").fs
    await expect(fs.readFile("status.json")).resolves.toBe(JSON.stringify({ status: "ok" }, null, 2))
    await expect(fs.list(".vitehub/sources")).resolves.toEqual([
      { path: ".vitehub/sources/status.json", type: "file" },
    ])
    await expect(fs.readFile(".vitehub/sources/status.json")).resolves.toContain("https://status.example.com/health")
  })

  it("supports text, POST request factories, and explicit paths", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("healthy"))
    const cookie = vi.fn(() => "session-token")

    registerWorkspace("fetch-text", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: fetch({
          body: { scope: "all" },
          headers: { authorization: "Bearer secret" },
          method: "POST",
          request: ({ request }) => ({
            cookies: { auth_token: cookie() },
            headers: { "x-request-method": request.method },
          }),
          responseType: "text",
          url: "https://status.example.com/query",
          workspacePath: "external/status/health.txt",
        }),
      },
    }))

    const workspace = useWorkspace("fetch-text")

    await expect(workspace.fs.readFile("external/status/health.txt")).resolves.toBe("healthy")
    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(request).toHaveBeenCalledWith("https://status.example.com/query", expect.objectContaining({
      body: JSON.stringify({ scope: "all" }),
      method: "POST",
    }))
    expect((init.headers as Headers).get("authorization")).toBe("Bearer secret")
    expect((init.headers as Headers).get("cookie")).toBe("auth_token=session-token")
    expect((init.headers as Headers).get("x-request-method")).toBe("POST")
  })

  it("lets request preparation lower the fetch Source response limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("large"))
    registerWorkspace("fetch-bounded", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: fetch({
          maxResponseBytes: 100,
          request: { maxResponseBytes: 4 },
          responseType: "text",
          url: "https://status.example.com/large",
          workspacePath: "status.txt",
        }),
      },
    }))

    await expect(useWorkspace("fetch-bounded").fs.readFile("status.txt"))
      .rejects.toThrow("configured 4-byte limit")
  })

  it("enforces response limits for request-only fetch Sources", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("large"))
    registerWorkspace("fetch-request-bounded", defineWorkspace({
      sources: {
        status: fetch({
          maxResponseBytes: 4,
          responseType: "text",
          url: "https://status.example.com/large",
        }),
      },
      store: { provider: "memory" },
    }))
    const definition = await resolveRegisteredWorkspaceDefinition("fetch-request-bounded")
    const execution = createWorkspaceSourceRequestExecution(definition)

    await expect(execution?.executeSourceRequest({
      method: "GET",
      url: "https://status.example.com/large",
    })).rejects.toThrow("configured 4-byte limit")
  })

  it("serializes top-level JSON strings as valid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse("ok"))

    registerWorkspace("fetch-json-string", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: fetch({
          url: "https://status.example.com/string",
          workspacePath: "external/status/string.json",
        }),
      },
    }))

    const workspace = useWorkspace("fetch-json-string")

    await expect(workspace.fs.readFile("external/status/string.json")).resolves.toBe(JSON.stringify("ok"))
  })

  it("accepts HEAD requests and rejects unsupported response types", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(""))
    registerWorkspace("fetch-head", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        ping: fetch({
          method: "HEAD",
          responseType: "text",
          url: "https://status.example.com/ping",
          workspacePath: "external/status/ping.txt",
        }),
      },
    }))

    const workspace = useWorkspace("fetch-head")

    await expect(workspace.fs.readFile("external/status/ping.txt")).resolves.toBe("")
    expect(request).toHaveBeenCalledWith("https://status.example.com/ping", expect.objectContaining({ method: "HEAD" }))
    expect(() => fetch({
      responseType: "arrayBuffer" as never,
      url: "https://status.example.com/image",
    })).toThrow("responseType")
  })

  it("supports query URLs and keeps source paths read-only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }))
    registerWorkspace("fetch-readonly", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: fetch({
          url: "https://status.example.com/api/summary?region=eu",
          workspacePath: "status/eu.json",
        }),
      },
    }))

    const workspace = useWorkspace("fetch-readonly", { mode: "write" })

    await expect(workspace.fs.writeFile("status/eu.json", "nope")).rejects.toThrow("read-only")
  })

  it("materializes live fetch sources only when explicitly requested", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ready" }))
    registerWorkspace("fetch-materialize", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        status: fetch({
          url: "https://status.example.com/api/summary",
          workspacePath: "status/summary.json",
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("fetch-materialize")

    await expect(workspace.diff()).resolves.toMatchObject({ entries: [] })
    await workspace.materializeSources?.({ sources: ["status"] })
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "status/summary.json", type: "added" })]),
    })
  })

  it("hides stale materialized files from live fetch source listings", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("status/old.json", {
      content: "{}",
      metadata: { source: "status" },
      path: "status/old.json",
    })
    const view = createWorkspaceSourceView({
      name: "fetch-stale-listing",
      sources: {
        status: fetch({
          url: "https://status.example.com/new",
          workspacePath: "status/new.json",
        }),
      },
    }, store)

    await expect(view.list("status")).resolves.toEqual([
      { path: "status/new.json", type: "file" },
    ])
    await expect(view.list("status", { exclude: ["status"], recursive: true })).resolves.toEqual([])
    await expect(view.glob("status/*.json")).resolves.toEqual([
      { path: "status/new.json", type: "file" },
    ])
  })

  it("searches live fetch source content", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ status: "searchable" }))
    const view = createWorkspaceSourceView({
      name: "fetch-search",
      sources: {
        status: fetch({
          url: "https://status.example.com/search",
          workspacePath: "status/search.json",
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.search({ pattern: "searchable", paths: ["status"] })).resolves.toEqual([
      expect.objectContaining({ path: "status/search.json", text: expect.stringContaining("searchable") }),
    ])
    await expect(view.search({ pattern: "searchable", paths: [""] })).resolves.toEqual([
      expect.objectContaining({ path: "status/search.json", text: expect.stringContaining("searchable") }),
    ])
  })

  it("keeps unrelated root store entries visible beside root live fetch sources", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("docs/readme.md", {
      content: "# Docs\n",
      path: "docs/readme.md",
    })
    const view = createWorkspaceSourceView({
      name: "fetch-root-listing",
      sources: {
        status: fetch({
          url: "https://status.example.com/summary",
          workspacePath: "summary.json",
        }),
      },
    }, store)

    await expect(view.list("")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs", type: "directory" }),
      expect.objectContaining({ path: "summary.json", type: "file" }),
    ]))
    await expect(view.stat("")).resolves.toEqual({ path: "", type: "directory" })
    await expect(view.exists("")).resolves.toBe(true)
  })

  it("refreshes root live fetch source metadata before write guards", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ status: "old" }))
      .mockResolvedValueOnce(jsonResponse({ status: "new" }))
    const store = createMemoryWorkspaceStore()
    const firstView = createWorkspaceSourceView({
      name: "fetch-root-refresh",
      sources: {
        status: fetch({
          url: "https://status.example.com/old",
          workspacePath: "old.json",
        }),
      },
    }, store)
    await firstView.materializeSources({ sources: ["status"] })

    const nextView = createWorkspaceSourceView({
      name: "fetch-root-refresh",
      sources: {
        status: fetch({
          url: "https://status.example.com/new",
          workspacePath: "new.json",
        }),
      },
    }, store)
    await expect(nextView.writeFile("old.json", "editable")).resolves.toBe("old.json")
    await expect(nextView.readFile("old.json")).resolves.toBe("editable")
  })

  it("exposes request-only fetch descriptors under .vitehub/sources", async () => {
    const querySchema = {
      "~standard": {
        jsonSchema: {
          input() {
            return {
              additionalProperties: false,
              properties: {
                region: { default: "eu", type: "string" },
              },
              type: "object",
            }
          },
        },
        validate(input: unknown) {
          return { value: { region: "eu", ...(input as Record<string, unknown>) } }
        },
      },
    } as const
    const view = createWorkspaceSourceView({
      name: "fetch-request-only",
      sources: {
        inventoryHealthSummary: fetch({
          cookies: { auth_token: "secret" },
          querySchema,
          url: "https://portal.example.com/runtime/inventory-health",
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.exists(".vitehub/sources/inventoryHealthSummary.json")).resolves.toBe(true)
    await expect(view.exists("inventoryHealthSummary")).resolves.toBe(false)
    await expect(view.list(".vitehub/sources")).resolves.toEqual([
      { path: ".vitehub/sources/inventoryHealthSummary.json", type: "file" },
    ])
    await expect(view.list("", { exclude: [".vitehub"], recursive: true })).resolves.toEqual([])
    const descriptor = JSON.parse(await view.readFile(".vitehub/sources/inventoryHealthSummary.json"))
    expect(descriptor).toEqual({
      credentials: { cookies: ["auth_token"] },
      method: "GET",
      request: {
        querySchema: {
          additionalProperties: false,
          properties: {
            region: { default: "eu", type: "string" },
          },
          type: "object",
        },
      },
      responseType: "json",
      sourceKey: "inventoryHealthSummary",
      url: "https://portal.example.com/runtime/inventory-health",
    })
    await expect(view.writeFile(".vitehub/sources/inventoryHealthSummary.json", "{}")).rejects.toThrow("read-only")
  })

  it("rejects unsafe request descriptor source keys", () => {
    expect(() => createWorkspaceSourceView({
      name: "fetch-unsafe-nested-source-key",
      sources: {
        "nested/status": fetch({
          url: "https://status.example.com/health",
        }),
      },
    }, createMemoryWorkspaceStore())).toThrow("single safe file stem")

    expect(() => createWorkspaceSourceView({
      name: "fetch-unsafe-json-source-key",
      sources: {
        "status.json": fetch({
          url: "https://status.example.com/health",
        }),
      },
    }, createMemoryWorkspaceStore())).toThrow("single safe file stem")
  })

  it("uses schema-derived defaults for source-backed fetch reads", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: "ok" }))
    const querySchema = {
      "~standard": {
        jsonSchema: {
          input() {
            return {
              properties: {
                region: { default: "eu", type: "string" },
              },
              type: "object",
            }
          },
        },
        validate(input: unknown) {
          return { value: { region: "eu", ...(input as Record<string, unknown>) } }
        },
      },
    } as const
    const view = createWorkspaceSourceView({
      name: "fetch-schema-default",
      sources: {
        status: fetch({
          querySchema,
          url: "https://status.example.com/api/summary",
          workspacePath: "status/summary.json",
        }),
      },
    }, createMemoryWorkspaceStore())

    await expect(view.readFile("status/summary.json")).resolves.toContain("\"status\": \"ok\"")
    expect(request.mock.calls[0]?.[0]).toBe("https://status.example.com/api/summary?region=eu")
  })

  it("rejects ambiguous request part declarations", () => {
    const schema = {
      "~standard": {
        jsonSchema: { input: () => ({ type: "object" }) },
        validate: () => ({ value: {} }),
      },
    } as const

    expect(() => fetch({
      query: { region: "eu" },
      querySchema: schema,
      url: "https://status.example.com/query",
    })).toThrow("either query or querySchema")
    expect(() => fetch({
      body: { scope: "all" },
      bodySchema: schema,
      method: "POST",
      url: "https://status.example.com/query",
    })).toThrow("either body or bodySchema")
    expect(() => fetch({
      body: { scope: "all" },
      method: "GET",
      url: "https://status.example.com/query",
    })).toThrow("GET requests cannot declare body")
  })
})
