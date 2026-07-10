import { describe, expect, it } from "vitest"

import { normalizeAgentInvoker } from "../src/invoker.ts"

describe("Agent Invoker", () => {
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
})
