import { afterEach, describe, expect, it } from "vitest"

import { defineAgent } from "../src/agent.ts"
import { consoleInvocationsKey } from "../src/console/internal.ts"
import { assertLocalConsoleRequest } from "../src/console/runtime/server/local-request.ts"

import type { AgentInvocations } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/local-request.ts"

type ConsoleGlobal = typeof globalThis & Record<symbol, AgentInvocations | undefined>

const scope = globalThis as ConsoleGlobal
const fakeInvocations = (name: string) => ({ name }) as unknown as AgentInvocations

function event(address: string | undefined, method = "GET"): ConsoleRequestEvent {
  const headers = new Headers({ host: "localhost" })
  return {
    context: address ? { clientAddress: address } : {},
    headers,
    method,
    req: { url: "http://localhost/_vitehub" },
  }
}

afterEach(() => {
  delete scope[consoleInvocationsKey]
})

describe("Agent invocation console", () => {
  it("supplies the console journal to framework Agent Definitions without a store", () => {
    const fallback = fakeInvocations("console")
    scope[consoleInvocationsKey] = fallback

    const agent = defineAgent({ driver: { run: () => "ok" } })

    expect(agent.invocations).toBe(fallback)
  })

  it("preserves an explicitly configured invocation journal", () => {
    const explicit = fakeInvocations("explicit")
    scope[consoleInvocationsKey] = fakeInvocations("console")

    const agent = defineAgent({ driver: { run: () => "ok" }, invocations: explicit })

    expect(agent.invocations).toBe(explicit)
  })

  it("lets a later invocation journal assignment replace the console fallback", () => {
    scope[consoleInvocationsKey] = fakeInvocations("console")
    const agent = defineAgent({ driver: { run: () => "ok" } })
    const assigned = fakeInvocations("assigned")

    agent.invocations = assigned
    scope[consoleInvocationsKey] = fakeInvocations("replacement")

    expect(agent.invocations).toBe(assigned)
  })

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("accepts GET requests from loopback address %s", (address) => {
    expect(() => assertLocalConsoleRequest(event(address))).not.toThrow()
  })

  it("accepts loopback addresses from Nitro's Node request adapter", () => {
    const value = event(undefined)
    value.node = { req: { socket: { remoteAddress: "127.0.0.1" } } }

    expect(() => assertLocalConsoleRequest(value)).not.toThrow()
  })

  it("accepts Nuxt development requests forwarded from loopback", () => {
    const value = event(undefined)
    value.headers = new Headers({ host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1" })

    expect(() => assertLocalConsoleRequest(value)).not.toThrow()
  })

  it("hides console handlers from non-loopback requests and untrusted forwarding headers", () => {
    const forwarded = event("203.0.113.2")
    forwarded.headers = new Headers({ host: "localhost", "x-forwarded-for": "127.0.0.1" })

    expect(() => assertLocalConsoleRequest(forwarded)).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => assertLocalConsoleRequest(event(undefined))).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("rejects a non-loopback forwarded client behind a loopback proxy", () => {
    const value = event("127.0.0.1")
    value.headers = new Headers({ host: "localhost", "x-forwarded-for": "203.0.113.2, 127.0.0.1" })

    expect(() => assertLocalConsoleRequest(value)).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("rejects forwarded requests for a non-local host", () => {
    const value = event(undefined)
    value.headers = new Headers({ host: "192.0.2.10:3000", "x-forwarded-for": "127.0.0.1" })

    expect(() => assertLocalConsoleRequest(value)).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("treats malformed hosts as unavailable", () => {
    const value = event("127.0.0.1")
    value.headers = new Headers({ host: "[invalid" })

    expect(() => assertLocalConsoleRequest(value)).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("rejects non-GET console requests", () => {
    expect(() => assertLocalConsoleRequest(event("127.0.0.1", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
  })
})
