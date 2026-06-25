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
          operations: { allow: ["listCustomers"] },
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
          operations: { allow: ["deleteCustomer"] },
          spec: portalSpec(),
        }),
      ],
    }, runtime(), { prompt: "delete" })).rejects.toThrow("v1 supports GET, HEAD, and POST")
  })

  it("can hide tools by invocation context", async () => {
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")
    const capability = openapi({
      enabled: ({ actor }) => actor.kind === "portal",
      operations: { allow: ["listCustomers"] },
      spec: portalSpec(),
    })

    const hidden = await resolveAgentCapabilities({
      capabilities: [capability],
    }, runtime(), { context: { actor: { id: "support", kind: "support" } }, prompt: "list" })
    const visible = await resolveAgentCapabilities({
      capabilities: [capability],
    }, runtime(), { context: { actor: { id: "portal", kind: "portal" } }, prompt: "list" })

    expect(hidden.tools).toBeUndefined()
    expect(Object.keys(visible.tools || {})).toEqual(["listCustomers"])
  })

  it("uses defaults and headers while omitting host-supplied fields from tool schema", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }))
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const { openapi } = await import("../src/capabilities.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [
        openapi({
          defaults: ({ context }) => ({
            body: { cubeToken: context.get<{ cubeToken: string }>("portal")?.cubeToken },
            path: { tenantId: "acme" },
            query: { currency: "EUR" },
          }),
          headers: ({ context }) => ({
            cookie: `preview=${context.get<{ previewCookie: string }>("portal")?.previewCookie}`,
            "x-cube-token": context.get<{ cubeToken: string }>("portal")?.cubeToken || "",
          }),
          input: {
            omit: {
              body: ["cubeToken"],
              path: ["tenantId"],
              query: ["currency"],
            },
          },
          operations: { allow: ["createOrder"] },
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
    const schema = tools.createOrder.inputSchema as {
      properties: Record<string, { properties?: Record<string, unknown>, required?: string[] } | undefined>
    }

    expect(schema.properties.path).toBeUndefined()
    expect(schema.properties.query).toBeUndefined()
    const bodySchema = schema.properties.body!
    expect(bodySchema.required).toEqual(["sku"])
    expect(bodySchema.properties?.cubeToken).toBeUndefined()

    await expect(tools.createOrder.execute?.({
      body: { quantity: 2, sku: "sku-1" },
    })).resolves.toEqual({ ok: true })

    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(request.mock.calls[0]?.[0]).toBe("https://portal.example.com/runtime/tenants/acme/orders?currency=EUR")
    expect(init.body).toBe(JSON.stringify({ cubeToken: "cube-token", quantity: 2, sku: "sku-1" }))
    expect((init.headers as Headers).get("cookie")).toBe("preview=preview-cookie")
    expect((init.headers as Headers).get("x-cube-token")).toBe("cube-token")
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
          defaults: {
            body: { cubeToken: "cube-token" },
            path: { tenantId: "acme" },
          },
          input: { omit: { body: ["cubeToken"], path: ["tenantId"] } },
          operations: { allow: ["createOrder"] },
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
