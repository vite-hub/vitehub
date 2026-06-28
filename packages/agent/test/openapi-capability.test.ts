import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentToolSet } from "../src/types.ts"

const runtime = () => ({
  capabilities: {},
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  })
}

function portalSpec() {
  return {
    openapi: "3.1.0",
    servers: [{ url: "https://portal.example.com/runtime" }],
    paths: {
      "/customers": {
        get: {
          operationId: "listCustomers",
          parameters: [
            { in: "query", name: "region", schema: { type: "string" } },
          ],
          summary: "List customers.",
        },
      },
      "/customers/{id}": {
        delete: {
          operationId: "deleteCustomer",
          summary: "Delete customer.",
        },
      },
      "/tenants/{tenantId}/orders": {
        post: {
          operationId: "createOrder",
          parameters: [
            { in: "path", name: "tenantId", required: true, schema: { type: "string" } },
            { in: "query", name: "currency", schema: { type: "string" } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  additionalProperties: false,
                  properties: {
                    cubeToken: { type: "string" },
                    note: { nullable: true, type: "string" },
                    quantity: { type: "number" },
                    sku: { type: "string" },
                  },
                  required: ["cubeToken", "sku"],
                  type: "object",
                },
              },
            },
          },
          summary: "Create order.",
        },
      },
    },
  }
}

function nonObjectBodySpec() {
  return {
    openapi: "3.1.0",
    servers: [{ url: "https://portal.example.com/runtime" }],
    paths: {
      "/notes": {
        post: {
          operationId: "setNote",
          requestBody: {
            content: {
              "application/json": {
                schema: { nullable: true, type: "string" },
              },
            },
          },
          summary: "Set note.",
        },
      },
      "/tags": {
        post: {
          operationId: "replaceTags",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  items: { type: "string" },
                  type: "array",
                },
              },
            },
          },
          summary: "Replace tags.",
        },
      },
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("openapi capability", () => {
  it("ignores unsupported methods outside the operation allowlist", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          operations: ["listCustomers"],
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "list" })

    expect(Object.keys(resolved.tools || {})).toEqual(["listCustomers"])
  })

  it("fails only when an allowed operation uses an unsupported method", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    await expect(resolveAgentCapabilities({
      capabilities: [
        openapi({
          operations: ["deleteCustomer"],
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "delete" })).rejects.toThrow("v1 supports GET, HEAD, and POST")
  })

  it("derives request server from OpenAPI servers", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          operations: ["listCustomers"],
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "list" })

    await (resolved.tools as AgentToolSet).listCustomers.execute?.({ query: { region: "eu" } })

    expect(request.mock.calls[0]?.[0]).toBe("https://portal.example.com/runtime/customers?region=eu")
  })

  it("resolves dynamic specs per invocation", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")
    const capability = openapi({
      operations: ["listCustomers"],
      spec: ({ context }) => ({
        ...portalSpec(),
        servers: [{ url: context.get<{ baseUrl: string }>("portal")?.baseUrl }],
      }),
    })

    const first = await resolveAgentCapabilities({
      capabilities: [capability],
    }, runtime(), {
      context: { portal: { baseUrl: "https://first.example.com/api" } },
      prompt: "list",
    })
    await (first.tools as AgentToolSet).listCustomers.execute?.({})

    const second = await resolveAgentCapabilities({
      capabilities: [capability],
    }, runtime(), {
      context: { portal: { baseUrl: "https://second.example.com/api" } },
      prompt: "list",
    })
    await (second.tools as AgentToolSet).listCustomers.execute?.({})

    expect(request.mock.calls.map(call => call[0])).toEqual([
      "https://first.example.com/api/customers",
      "https://second.example.com/api/customers",
    ])
  })

  it("resolves contextual server overrides per invocation", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")
    const capability = openapi({
      operations: ["listCustomers"],
      server({ context }) {
        const server = context.get<{ baseUrl: string }>("portal")?.baseUrl
        if (!server) throw new Error("Portal server missing.")
        return server
      },
      spec: { ...portalSpec(), servers: [] },
    })

    const first = await resolveAgentCapabilities({
      capabilities: [capability],
    }, runtime(), {
      context: { portal: { baseUrl: "https://first-override.example.com/runtime" } },
      prompt: "list",
    })
    await (first.tools as AgentToolSet).listCustomers.execute?.({})

    const second = await resolveAgentCapabilities({
      capabilities: [capability],
    }, runtime(), {
      context: { portal: { baseUrl: "https://second-override.example.com/runtime" } },
      prompt: "list",
    })
    await (second.tools as AgentToolSet).listCustomers.execute?.({})

    expect(request.mock.calls.map(call => call[0])).toEqual([
      "https://first-override.example.com/runtime/customers",
      "https://second-override.example.com/runtime/customers",
    ])
  })

  it("generates a Capability CLI from allowed operations and OpenAPI descriptions", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ customers: ["acme"] }))
    const {
      resolveAgentCapabilities,
    } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          cli: {
            description: "Inspect live Portal data.",
            name: "portal",
          },
          operations: ["listCustomers", "createOrder"],
          spec: ({ context }) => ({
            ...portalSpec(),
            servers: [{ url: context.get<{ baseUrl: string }>("portal")?.baseUrl }],
          }),
        }),
      ],
    }, runtime(), {
      context: { portal: { baseUrl: "https://cli.example.com/runtime" } },
      prompt: "list",
    })

    expect(Object.keys(resolved.tools || {})).toEqual(["portal"])
    expect(resolved.tools?.portal?.description).toContain("`list-customers --json`")
    expect(resolved.tools?.portal?.description).toContain("`create-order --json`")

    await expect(resolved.tools?.portal?.execute?.({
      argv: ["list-customers", "--json"],
      input: { query: { region: "eu" } },
    })).resolves.toMatchObject({
      cli: "portal",
      command: "portal list-customers --json",
      exitCode: 0,
      json: { customers: ["acme"] },
    })

    expect(request.mock.calls[0]?.[0]).toBe("https://cli.example.com/runtime/customers?region=eu")
  })

  it("prepares requests with runtime hook values before HTTP execution", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          operations: ["createOrder"],
          hooks: {
            request({ context, request }) {
              const cubeToken = context.get<{ cubeToken: string }>("portal")?.cubeToken
              const previewCookie = context.get<{ previewCookie: string }>("portal")?.previewCookie
              request.body = { ...(request.body as Record<string, unknown> | undefined), cubeToken }
              request.path.tenantId = "acme"
              request.query.currency = "EUR"
              if (cubeToken) request.headers.set("x-cube-token", cubeToken)
              if (previewCookie) request.cookies.preview = previewCookie
            },
          },
          spec: portalSpec(),
        }),
      ],
    }, runtime(), {
      context: {
        actor: { id: "portal", kind: "portal" },
        portal: { cubeToken: "cube-token", previewCookie: "preview-cookie" },
      },
      prompt: "create",
    })
    const tools = resolved.tools as AgentToolSet

    await expect(tools.createOrder.execute?.({
      body: { cubeToken: "model-token", quantity: 2, sku: "sku-1" },
      path: { tenantId: "model-tenant" },
      query: { currency: "USD" },
    })).resolves.toEqual({ ok: true })

    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(request.mock.calls[0]?.[0]).toBe("https://portal.example.com/runtime/tenants/acme/orders?currency=EUR")
    expect(JSON.parse(init.body as string)).toEqual({ cubeToken: "cube-token", quantity: 2, sku: "sku-1" })
    expect((init.headers as Headers).get("cookie")).toBe("preview=preview-cookie")
    expect((init.headers as Headers).get("x-cube-token")).toBe("cube-token")
  })

  it("prepares generated OpenAPI CLI requests with runtime hook values", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          cli: { name: "portal" },
          operations: ["createOrder"],
          hooks: {
            request({ context, request }) {
              request.body = {
                ...(request.body as Record<string, unknown> | undefined),
                cubeToken: context.get<{ cubeToken: string }>("portal")?.cubeToken,
              }
              request.path.tenantId = "acme"
              request.query.currency = "EUR"
            },
          },
          spec: portalSpec(),
        }),
      ],
    }, runtime(), {
      context: { portal: { cubeToken: "cube-token" } },
      prompt: "create",
    })

    await expect(resolved.tools?.portal?.execute?.({
      argv: ["create-order", "--json"],
      input: {
        body: { quantity: 2, sku: "sku-1" },
        query: { currency: "USD" },
      },
    })).resolves.toMatchObject({
      cli: "portal",
      exitCode: 0,
      json: { ok: true },
    })

    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(request.mock.calls[0]?.[0]).toBe("https://portal.example.com/runtime/tenants/acme/orders?currency=EUR")
    expect(JSON.parse(init.body as string)).toEqual({ cubeToken: "cube-token", quantity: 2, sku: "sku-1" })
  })

  it("validates generated OpenAPI CLI inputs before requests", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          cli: { name: "portal" },
          operations: ["createOrder"],
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "create" })

    await expect(resolved.tools?.portal?.execute?.({
      argv: ["create-order", "--json"],
      input: { body: {}, path: { tenantId: "acme" } },
    })).rejects.toThrow("createOrder request is invalid")
    await expect(resolved.tools?.portal?.execute?.({
      argv: ["create-order", "--json"],
      input: {
        body: { cubeToken: "cube-token", sku: "sku-1" },
        path: { tenantId: 123 },
      },
    })).rejects.toThrow("input.path.tenantId must be string")
    expect(request).not.toHaveBeenCalled()
  })

  it("accepts nullable generated OpenAPI CLI input values", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          cli: { name: "portal" },
          operations: ["createOrder"],
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "create" })

    await expect(resolved.tools?.portal?.execute?.({
      argv: ["create-order", "--json"],
      input: {
        body: { cubeToken: "cube-token", note: null, sku: "sku-1" },
        path: { tenantId: "acme" },
      },
    })).resolves.toMatchObject({
      cli: "portal",
      exitCode: 0,
      json: { ok: true },
    })
    expect((request.mock.calls[0]?.[1] as RequestInit).body).toBe(JSON.stringify({
      cubeToken: "cube-token",
      note: null,
      sku: "sku-1",
    }))
  })

  it("preserves non-object request bodies in generated OpenAPI CLI validation", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          cli: { name: "portal" },
          operations: ["replaceTags", "setNote"],
          spec: nonObjectBodySpec(),
        }),
      ],
    }, runtime(), { prompt: "update" })

    await expect(resolved.tools?.portal?.execute?.({
      argv: ["replace-tags", "--json"],
      input: { body: ["red", "blue"] },
    })).resolves.toMatchObject({
      cli: "portal",
      exitCode: 0,
      json: { ok: true },
    })
    await expect(resolved.tools?.portal?.execute?.({
      argv: ["set-note", "--json"],
      input: { body: "hello" },
    })).resolves.toMatchObject({
      cli: "portal",
      exitCode: 0,
      json: { ok: true },
    })
    await expect(resolved.tools?.portal?.execute?.({
      argv: ["set-note", "--json"],
      input: { body: null },
    })).resolves.toMatchObject({
      cli: "portal",
      exitCode: 0,
      json: { ok: true },
    })

    expect(request.mock.calls.map(call => (call[1] as RequestInit).body)).toEqual([
      JSON.stringify(["red", "blue"]),
      "hello",
      JSON.stringify(null),
    ])
  })

  it("uses text output format for generated OpenAPI CLI text responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("plain text", {
      headers: { "content-type": "text/plain" },
      status: 200,
    }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          cli: { name: "portal" },
          operations: ["listCustomers"],
          responseType: "text",
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "list" })
    expect(resolved.tools?.portal?.description).toContain("`list-customers`")
    expect(resolved.tools?.portal?.description).not.toContain("`list-customers --json`")

    await expect(resolved.tools?.portal?.execute?.({
      argv: ["list-customers"],
    })).resolves.toMatchObject({
      cli: "portal",
      exitCode: 0,
      stdout: "plain text\n",
    })
  })

  it("accepts visible request body fields at the top level", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          operations: ["createOrder"],
          hooks: {
            request({ request }) {
              request.body = { ...(request.body as Record<string, unknown> | undefined), cubeToken: "cube-token" }
              request.path.tenantId = "acme"
            },
          },
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "create" })

    const tools = resolved.tools as AgentToolSet
    await expect(tools.createOrder.execute?.({
      quantity: 2,
      sku: "sku-1",
    })).resolves.toEqual({ ok: true })

    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ cubeToken: "cube-token", quantity: 2, sku: "sku-1" })
  })

  it("can transform raw operation responses with request context", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      data: [{ "Product.sku": "sku-1", "PurchaseOrder.quantity": 12 }],
    }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          operations: ["createOrder"],
          hooks: {
            request({ request }) {
              request.body = { ...(request.body as Record<string, unknown> | undefined), cubeToken: "cube-token" }
              request.path.tenantId = "acme"
            },
          },
          spec: portalSpec(),
          transformResponse(response, context) {
            return {
              operationId: context.operation.id,
              status: context.response.status,
              rows: (response as { data: Array<Record<string, unknown>> }).data.map(row => ({
                quantity: row["PurchaseOrder.quantity"],
                sku: row["Product.sku"],
              })),
            }
          },
        }),
      ],
    }, runtime(), { prompt: "create" })
    const tools = resolved.tools as AgentToolSet

    await expect(tools.createOrder.execute?.({
      body: { sku: "sku-1" },
    })).resolves.toEqual({
      operationId: "createOrder",
      rows: [{ quantity: 12, sku: "sku-1" }],
      status: 200,
    })
  })
})
