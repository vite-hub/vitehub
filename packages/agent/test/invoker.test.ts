import { describe, expect, it } from "vitest"

import { agentInvokerLabel, normalizeAgentInvoker, portableResolvedAgentInvokerInput, restoreResolvedAgentInvokerInput, withoutResolvedAgentInvokerInput, withResolvedAgentInvokerInput } from "../src/invoker.ts"
import { agentInvocationCallerAbortSignal, copyAgentInvocationCallerAbortSignal, markAgentInvocationCallerAbortSignal } from "../src/internal/invocation-input.ts"
import { sameInlineInvoker } from "../src/internal/inline-invoker.ts"

describe("Agent Invoker", () => {
  it.each([false, true, undefined])("preserves registered caller-signal provenance across invoker input clones: %s", (supplied) => {
    const input = withResolvedAgentInvokerInput({ abortSignal: new AbortController().signal, prompt: "hello" }, { id: "owner", kind: "person" })
    markAgentInvocationCallerAbortSignal(input, supplied)
    const clones = [
      withResolvedAgentInvokerInput(input, { id: "resolved-owner", kind: "person" }),
      withoutResolvedAgentInvokerInput(input),
      portableResolvedAgentInvokerInput(input),
      restoreResolvedAgentInvokerInput(input),
    ]
    for (const clone of clones) {
      expect(clone).not.toBe(input)
      expect(clone.abortSignal).toBe(input.abortSignal)
      expect(agentInvocationCallerAbortSignal(clone)).toBe(supplied)
    }
  })

  it("does not inherit controller provenance when an input clone changes its signal", () => {
    const input = { abortSignal: new AbortController().signal, prompt: "hello" }
    markAgentInvocationCallerAbortSignal(input, false)
    const replacement = copyAgentInvocationCallerAbortSignal(input, { ...input, abortSignal: new AbortController().signal })
    expect(agentInvocationCallerAbortSignal(replacement)).toBe(true)
    const unmarked = { abortSignal: new AbortController().signal, prompt: "hello" }
    expect(agentInvocationCallerAbortSignal(copyAgentInvocationCallerAbortSignal(unmarked, { ...unmarked }))).toBe(true)
  })

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

  it("keeps distinct Proxy metadata separate through repeated invoker normalization", () => {
    const metadata = [1, 2].map(value => new Proxy({ value }, { get: () => undefined }))
    expect(JSON.stringify(metadata[0])).toBe(JSON.stringify(metadata[1]))
    const [left, right] = metadata.map(meta => normalizeAgentInvoker(normalizeAgentInvoker({ id: "user", meta })))
    expect(left?.meta).toEqual({ value: 1 })
    expect(right?.meta).toEqual({ value: 2 })
    expect(sameInlineInvoker(left, right)).toBe(false)
  })

  it("preserves accessors without reading them during metadata copying", () => {
    const role = () => { throw new Error("Unexpected metadata getter") }
    const meta = Object.defineProperty({}, "role", { enumerable: true, get: role })
    const left = normalizeAgentInvoker({ id: "user", meta })
    const right = normalizeAgentInvoker({ id: "user", meta })
    expect(Object.getOwnPropertyDescriptor(left.meta, "role")?.get).toBe(role)
    expect(sameInlineInvoker(left, right)).toBe(false)
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
    expect(portable.context?.invoker?.meta?.loadTenant).toBeUndefined()
  })
  it("preserves caller abort provenance through resolved invoker input clones", () => {
    const input = { prompt: "hello", abortSignal: new AbortController().signal }
    markAgentInvocationCallerAbortSignal(input, false)
    const resolved = withResolvedAgentInvokerInput(input, { id: "user-1", kind: "user" })
    const portable = portableResolvedAgentInvokerInput(resolved)
    expect(agentInvocationCallerAbortSignal(portable)).toBe(false)
  })

})
