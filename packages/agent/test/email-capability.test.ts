import { describe, expect, it, vi } from "vitest"

import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { email } from "../src/capabilities.ts"
import { applyAgentToolPolicies } from "../src/tool-runtime.ts"

function runtime(capabilities: Record<string, unknown> = {}) {
  return {
    capabilities,
    memo: vi.fn(),
    runtime: "unknown" as const,
    runtimeConfig: {},
    waitUntil: vi.fn(),
  }
}

async function resolveEmailTool(capabilities: Record<string, unknown>) {
  const resolved = await resolveAgentCapabilities({
    capabilities: [email({ from: "agent@example.com" })],
  }, runtime(capabilities), {})
  return resolved.tools!.email_send!
}

describe("email capability", () => {
  it("defines one write tool backed by the Email primitive", () => {
    const capability = email({
      from: "agent@example.com",
      policy: "require-approval",
      recipients: ["owner@example.com"],
    })

    expect(capability).toMatchObject({
      id: "email",
      metadata: { recipients: ["owner@example.com"] },
      mode: "write",
      requires: [{ primitive: "email" }],
    })
    expect(() => email({ from: " " })).toThrow("email({ from }) must be a non-empty string")
    expect(() => email({ from: "agent@example.com", recipients: "owner@example.com" as unknown as string[] })).toThrow("email({ recipients }) must be an array of non-empty email addresses")
    expect(() => email({ from: "agent@example.com", recipients: [123] as unknown as string[] })).toThrow("email({ recipients }) must be an array of non-empty email addresses")
    expect(() => email({ from: "agent@example.com", recipients: [" "] })).toThrow("email({ recipients }) must be an array of non-empty email addresses")
    expect(() => email({ from: "agent@example.com", recipients: Array(1) as string[] })).toThrow("email({ recipients }) must be an array of non-empty email addresses")
  })

  it("sends a validated plain-text message and preserves the primitive result", async () => {
    const send = vi.fn(async () => ({ driver: "memory", id: "memory-1" }))
    const tool = await resolveEmailTool({ email: { kind: "email", value: { send } } })

    expect(tool.name).toBe("email_send")
    expect(tool.policy).toBeUndefined()
    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["to", "subject", "text"],
      type: "object",
    })
    await expect(tool.execute?.({
      subject: "Weekly report",
      text: "The report is ready.",
      to: ["owner@example.com", "ops@example.com"],
    })).resolves.toEqual({ driver: "memory", id: "memory-1" })
    expect(send).toHaveBeenCalledWith({
      from: "agent@example.com",
      subject: "Weekly report",
      text: "The report is ready.",
      to: ["owner@example.com", "ops@example.com"],
    })
  })

  it("accepts a plain runtime handle and forwards policy", async () => {
    const send = vi.fn(async () => ({ driver: "memory", id: "memory-1" }))
    const policy = vi.fn(() => "allow" as const)
    const resolved = await resolveAgentCapabilities({
      capabilities: [email({ from: "agent@example.com", policy })],
    }, runtime({ email: { send } }), {})

    expect(resolved.tools!.email_send!.policy).toBe(policy)
    await resolved.tools!.email_send!.execute?.({ subject: "Hello", text: "Hi", to: "you@example.com" })
    expect(send).toHaveBeenCalledOnce()
  })

  it("enforces the recipient allowlist before user policy", async () => {
    const send = vi.fn(async () => ({ driver: "memory", id: "memory-1" }))
    const policy = vi.fn(() => "allow" as const)
    const resolved = await resolveAgentCapabilities({
      capabilities: [email({
        from: "agent@example.com",
        policy,
        recipients: ["owner@example.com", "ops@example.com"],
      })],
    }, runtime({ email: { send } }), {})
    const tool = applyAgentToolPolicies({ email_send: resolved.tools!.email_send! })!.email_send!

    expect(tool.description).toContain('Allowed recipients: ["owner@example.com","ops@example.com"].')

    await expect(tool.execute?.({
      subject: "Hello",
      text: "Hi",
      to: [" OWNER@example.com ", "ops@example.com"],
    })).resolves.toEqual({ driver: "memory", id: "memory-1" })
    expect(send).toHaveBeenLastCalledWith({
      from: "agent@example.com",
      subject: "Hello",
      text: "Hi",
      to: [" OWNER@example.com ", "ops@example.com"],
    })
    expect(policy).toHaveBeenCalledOnce()

    await expect(tool.execute?.({
      subject: "Hello",
      text: "Hi",
      to: ["owner@example.com", "other@example.com"],
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED", name: "ViteHubError" })
    await expect(tool.execute?.({
      subject: "Hello",
      text: "Hi",
      to: Array(1) as string[],
    })).rejects.toMatchObject({ code: "CAPABILITY_DENIED", name: "ViteHubError" })
    expect(send).toHaveBeenCalledOnce()
    expect(policy).toHaveBeenCalledOnce()
  })

  it("treats an empty recipient allowlist as deny-all", async () => {
    const send = vi.fn()
    const resolved = await resolveAgentCapabilities({
      capabilities: [email({ from: "agent@example.com", policy: "allow", recipients: [] })],
    }, runtime({ email: { send } }), {})
    const tool = applyAgentToolPolicies({ email_send: resolved.tools!.email_send! })!.email_send!

    expect(tool.description).toContain("Sending is disabled because the configured recipient allowlist is empty.")
    await expect(tool.execute?.({ subject: "Hello", text: "Hi", to: "owner@example.com" })).rejects.toMatchObject({ code: "CAPABILITY_DENIED", name: "ViteHubError" })
    expect(send).not.toHaveBeenCalled()
  })

  it("preserves approval policy after the recipient allowlist", async () => {
    const send = vi.fn()
    const resolved = await resolveAgentCapabilities({
      capabilities: [email({
        from: "agent@example.com",
        policy: "require-approval",
        recipients: ["owner@example.com"],
      })],
    }, runtime({ email: { send } }), {})
    const tool = applyAgentToolPolicies({ email_send: resolved.tools!.email_send! })!.email_send!

    await expect(tool.execute?.({ subject: "Hello", text: "Hi", to: "owner@example.com" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", name: "ViteHubError" })
    await expect(tool.execute?.({ subject: "Hello", text: "Hi", to: "other@example.com" })).rejects.toMatchObject({ code: "CAPABILITY_DENIED", name: "ViteHubError" })
    expect(send).not.toHaveBeenCalled()
  })

  it("rejects invalid tool input before delivery", async () => {
    const send = vi.fn()
    const tool = await resolveEmailTool({ email: { send } })

    await expect(tool.execute?.({ subject: "Hello", text: "Hi", to: [] })).rejects.toThrow("email_send to")
    await expect(tool.execute?.({ subject: "Hello", text: "Hi", to: ["you@example.com", " "] })).rejects.toThrow("email_send to")
    await expect(tool.execute?.({ subject: "Hello", text: "Hi", to: Array(1) as string[] })).rejects.toThrow("email_send to")
    await expect(tool.execute?.({ subject: " ", text: "Hi", to: "you@example.com" })).rejects.toThrow("email_send subject")
    await expect(tool.execute?.({ subject: "Hello", text: " ", to: "you@example.com" })).rejects.toThrow("email_send text")
    expect(send).not.toHaveBeenCalled()
  })

  it("keeps the allowlist boundary when tools are called without runtime policy wrapping", async () => {
    const send = vi.fn()
    const resolved = await resolveAgentCapabilities({
      capabilities: [email({ from: "agent@example.com", recipients: ["owner@example.com"] })],
    }, runtime({ email: { send } }), {})

    await expect(resolved.tools!.email_send!.execute?.({
      subject: "Hello",
      text: "Hi",
      to: "owner+tag@example.com",
    })).rejects.toThrow("recipient is outside the configured allowlist")
    expect(send).not.toHaveBeenCalled()
  })

  it("treats display-name forms as distinct recipient strings", async () => {
    const send = vi.fn(async () => ({ id: "message-1" }))
    const bare = await resolveAgentCapabilities({
      capabilities: [email({ from: "agent@example.com", recipients: ["owner@example.com"] })],
    }, runtime({ email: { send } }), {})

    await expect(bare.tools!.email_send!.execute?.({
      subject: "Hello",
      text: "Hi",
      to: "Owner <owner@example.com>",
    })).rejects.toThrow("recipient is outside the configured allowlist")

    const display = await resolveAgentCapabilities({
      capabilities: [email({ from: "agent@example.com", recipients: ["Owner <owner@example.com>"] })],
    }, runtime({ email: { send } }), {})
    await expect(display.tools!.email_send!.execute?.({
      subject: "Hello",
      text: "Hi",
      to: "owner <OWNER@example.com>",
    })).resolves.toEqual({ id: "message-1" })
    expect(send).toHaveBeenCalledOnce()
  })

  it("requires an Email client and preserves delivery errors", async () => {
    await expect(resolveEmailTool({})).rejects.toThrow('Capability "email" requires the email primitive to be configured.')
    await expect(resolveEmailTool({ email: {} })).rejects.toThrow("email primitive must expose send()")

    const error = new Error("safe delivery failure")
    const tool = await resolveEmailTool({ email: { send: vi.fn(async () => { throw error }) } })
    await expect(tool.execute?.({ subject: "Hello", text: "Hi", to: "you@example.com" })).rejects.toBe(error)
  })
})
