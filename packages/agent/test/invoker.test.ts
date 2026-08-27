import { describe, expect, it } from "vitest"

import { agentInvokerLabel, normalizeAgentInvoker, portableResolvedAgentInvokerInput, withResolvedAgentInvokerInput } from "../src/invoker.ts"

describe("Agent Invoker", () => {
  it("resolves a human-readable label from the explicit label or metadata name", () => {
    expect(agentInvokerLabel({ id: "user-1", label: "  Maxi  ", meta: { name: "Ignored" } })).toBe("Maxi")
    expect(agentInvokerLabel({ id: "user-1", meta: { name: "  Metadata Maxi  " } })).toBe("Metadata Maxi")
    expect(agentInvokerLabel({ id: "user-1", meta: { name: 123 } })).toBeUndefined()
  })

  it("normalizes Agent Actor email without changing invoker metadata", () => {
    const meta = {
      email: "metadata@example.net",
      scope: "acme",
    }
    const explicit = normalizeAgentInvoker({
      email: { address: " Support@Example.COM " },
      id: "tenant-1",
      meta,
    })

    expect(explicit).toEqual({
      email: {
        address: "support@example.com",
        domain: "example.com",
      },
      id: "tenant-1",
      meta,
    })
    expect(explicit.meta).not.toBe(meta)

    expect(normalizeAgentInvoker({
      email: "invalid",
      id: "tenant-1",
      meta,
    })).toEqual({
      email: {
        address: "metadata@example.net",
        domain: "example.net",
      },
      id: "tenant-1",
      meta,
    })

    expect(normalizeAgentInvoker({
      email: "invalid",
      id: "tenant-1",
      meta: { email: "also invalid", scope: "acme" },
    })).toEqual({
      id: "tenant-1",
      meta: { email: "also invalid", scope: "acme" },
    })
  })

  it("removes nonportable resolved invoker metadata from Workflow inputs", () => {
    const input = withResolvedAgentInvokerInput({ prompt: "hello" }, {
      id: "user-1",
      kind: "user",
      meta: { loadTenant: () => "acme", tenant: "acme" },
    })

    const portable = portableResolvedAgentInvokerInput(input)
    expect(portable.context).toMatchObject({
      actor: { id: "user-1", kind: "user", meta: { tenant: "acme" } },
      invoker: { id: "user-1", kind: "user", meta: { tenant: "acme" } },
    })
    expect((portable.context as { invoker: { meta: Record<string, unknown> } }).invoker.meta.loadTenant).toBeUndefined()
  })
})
