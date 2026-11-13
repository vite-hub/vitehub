
import { afterEach, describe, expect, it, vi } from "vitest"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { inspectServerEnv } from "@vite-hub/env/server"
import { installConsoleEnv } from "../src/console/runtime/server/env.ts"
import { consoleInvocationsIdentityKey, consoleInvocationsIdentityRootKey, consoleInvocationsKey, consoleInvocationsRegistryKey, consoleInvocationsRootIdentityRegistryKey, consoleInvocationsRootKey, installConsoleInvocationFallback } from "../src/console/internal.ts"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const callURL = "http://vitehub.local/_vitehub/rpc"

function call(body: string, init: RequestInit = {}): Promise<Response> {
  return handleConsoleRpcRequest(new Request(callURL, {
    body,
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
    ...init,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of [consoleInvocationsKey, consoleInvocationsRootKey, consoleInvocationsIdentityKey, consoleInvocationsIdentityRootKey, consoleInvocationsRegistryKey, consoleInvocationsRootIdentityRegistryKey]) {
    Reflect.deleteProperty(globalThis, key)
    Reflect.deleteProperty(process, key)
  }
})

describe("Console RPC", () => {
  it.each(["team/run", "team%2Frun", "%E0%A4%A"])("preserves decoded invocation ids: %s", async (id) => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-08-23T12:00:00.000Z"
    await store.create({ id, createdAt: timestamp, updatedAt: timestamp, status: "completed", observations: [], traceId: "trace-rpc-encoded" })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const response = await call(operationRpcBody("invocations.get", { id }))
    expect(response.status).toBe(200)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ ok: true, value: { invocation: { id } } })
  })

  it("preserves request bindings through Env status inspection", async () => {
    installConsoleSections("/console-rpc-env", ["env"])
    const binding = "request-only-secret"
    installConsoleEnv("/console-rpc-env", { entries: [] }, async (event) => {
      expect(event["~standard"].runtime?.cloudflare?.env).toEqual({ RPC_TOKEN: binding })
      return inspectServerEnv({ token: { required: true, schema: { kind: "string" }, secret: true, source: { kind: "env", label: "env:RPC_TOKEN", name: "RPC_TOKEN", serializable: true } } })
    })
    const request = Object.assign(new Request(callURL, {
      body: operationRpcBody("env.get", { status: true }),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }), { runtime: { name: "cloudflare", cloudflare: { context: { waitUntil: vi.fn(), passThroughOnException: vi.fn() }, env: { RPC_TOKEN: binding } } } })
    const response = await consoleRpcHandler.fetch(request)
    expect(response.status).toBe(200)
    const body = await operationRpcResponseResult(response)
    expect(body).toMatchObject({ ok: true, value: { status: [{ status: "available", blocking: false }] } })
    expect(JSON.stringify(body)).not.toContain(binding)
  })

  it("returns operation results and errors with no-store headers", async () => {
    installConsoleSections("/console-rpc-test", ["agents"])
    const success = await call(operationRpcBody("sections.list", {}))
    expect(success.status).toBe(200)
    expect(success.headers.get("cache-control")).toBe("no-store")
    expect(success.headers.get("x-content-type-options")).toBe("nosniff")
    expect(success.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    await expect(operationRpcResponseResult(success)).resolves.toMatchObject({ ok: true, value: { sections: ["agents"] } })

    const failure = await call(operationRpcBody("definitions.list"))
    expect(failure.status).toBe(400)
    await expect(operationRpcResponseResult(failure)).resolves.toMatchObject({ code: "INTERNAL_R0022", fix: expect.stringContaining("--help"), message: expect.stringContaining("section"), ok: false, status: 400 })
  })

  it("preserves upstream search status messages in RPC errors", async () => {
    const response = await call(operationRpcBody("search.query", { search: "x".repeat(257) }))
    expect(response.status).toBe(400)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({
      message: "Console search must be at most 256 characters.",
      ok: false,
      status: 400,
    })
  })

  it("rejects malformed calls before running an operation", async () => {
    const cases: Array<[Promise<Response>, number]> = [
      [handleConsoleRpcRequest(new Request(callURL, { headers: { [consoleRpcHeader]: "1" } })), 405],
      [handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__sse", { body: "{}", headers: { [consoleRpcHeader]: "1" }, method: "POST" })), 404],
      [handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/other/_vitehub/rpc", { body: "{}", headers: { [consoleRpcHeader]: "1" }, method: "POST" })), 404],
      [handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", { body: "{}", headers: { [consoleRpcHeader]: "1" }, method: "POST" })), 404],
      [call("{"), 400],
      [call(JSON.stringify([])), 400],
      [call(`{"operation":"sections.list","input":{}}`), 400],
      [call(JSON.stringify({ m: "sections.list", a: [] })), 400],
      [call(JSON.stringify({ m: "sections.list", a: [], t: "q", i: "1", o: true })), 400],
      [call(JSON.stringify({ m: "sections.list", a: [{}, {}], t: "q", i: "1" })), 400],
      [call(operationRpcBody("sections.list", [])), 400],
      [call(operationRpcBody("sections.list", { limit: 10 })), 400],
      [call(operationRpcBody("sections.list", { method: "DELETE" })), 400],
    ]
    for (const [pending, status] of cases) {
      const response = await pending
      expect(response.status).toBe(status)
      expect(response.headers.get("cache-control")).toBe("no-store")
      await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ ok: false, status })
    }
  })

  it.each([
    {},
    { [consoleRpcHeader]: "0" },
    { origin: "https://untrusted.example" },
    { origin: "https://untrusted.example", [consoleRpcHeader]: "1" },
    { origin: "null" },
    { origin: "null", "sec-fetch-site": "same-origin" },
    { origin: "http://vitehub.local:8080" },
    { origin: "https://untrusted.example", "sec-fetch-site": "none" },
    { "sec-fetch-site": "cross-site", [consoleRpcHeader]: "1" },
    { "sec-fetch-site": "same-site", [consoleRpcHeader]: "1" },
    { "sec-fetch-site": "none" },
  ])("rejects foreign browser calls before running an operation: %j", async (headers) => {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await handleConsoleRpcRequest(new Request(callURL, {
        body: method === "POST" ? operationRpcBody("sections.list") : undefined,
        headers,
        method,
      }))
      expect(response.status).toBe(403)
      expect(response.headers.has("access-control-allow-origin")).toBe(false)
      await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_REJECTED", fix: expect.stringContaining("Origin"), message: "Cross-origin Console requests are not allowed.", ok: false, status: 403 })
    }
  })

  it.each([
    { origin: "https://vitehub.local" },
    { "sec-fetch-site": "same-origin" },
    { origin: "https://vitehub.local", "sec-fetch-site": "same-origin" },
    { [consoleRpcHeader]: "1" },
  ])("accepts same-origin evidence or the marker under a mounted Console path: %j", async (headers) => {
    installConsoleSections("/console-rpc-test", ["agents"])
    const response = await handleConsoleRpcRequest(new Request("https://vitehub.local/tools/_vitehub/rpc", {
      body: operationRpcBody("sections.list"),
      headers,
      method: "POST",
    }))
    expect(response.status).toBe(200)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ ok: true, value: { sections: ["agents"] } })
  })

  it("accepts browser same-origin metadata behind TLS termination", async () => {
    const response = await handleConsoleRpcRequest(new Request(callURL, {
      body: operationRpcBody("sections.list"),
      headers: { origin: "https://vitehub.local", "sec-fetch-site": "same-origin" },
      method: "POST",
    }))
    expect(response.status).toBe(200)
  })

  it("limits the complete call body", async () => {
    const oversized = await call(operationRpcBody("agents.invoke", { prompt: "x".repeat(16 * 1_024 * 1_024) }))
    expect(oversized.status).toBe(413)
    await expect(operationRpcResponseResult(oversized)).resolves.toMatchObject({ code: "CONSOLE_REQUEST_INVALID", docs: expect.stringMatching(/^https:\/\//), message: "Console request body exceeds the byte limit.", ok: false, status: 413 })
  })

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "then", "nothing.here"])("refuses the raw birpc call %s as an unknown operation", async (name) => {
    const response = await call(JSON.stringify({ m: name, a: [{}], t: "q", i: "probe" }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      t: "s",
      i: "probe",
      e: expect.objectContaining({ code: "CONSOLE_NOT_FOUND", message: "Console operation not found.", status: 404 }),
    })
  })

  it("sends a thrown operation error with its code and message, and without the stack", async () => {
    installConsoleSections("/console-rpc-test", ["agents"])
    const response = await call(operationRpcBody("definitions.list"))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toEqual({ t: "s", i: "test-call", e: { code: "INTERNAL_R0022", docs: expect.stringMatching(/^https:\/\//), fix: expect.any(String), message: expect.stringContaining("section"), status: 400 } })
    expect(JSON.stringify(body)).not.toMatch(/stack|\bat .*\.ts:\d+/)
  })

  it("answers a request that it cannot read without a call id", async () => {
    const response = await call("{")
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ t: "s", e: expect.objectContaining({ code: "CONSOLE_REQUEST_INVALID", message: "Malformed Console request.", status: 400 }) })
  })

  it("enforces the non-invocation limit on raw envelope bytes", async () => {
    const envelope = operationRpcBody("sections.list")
    const body = envelope.padEnd(64 * 1_024, " ")
    expect((await call(body)).status).toBe(200)
    const response = await call(`${body} `)
    expect(response.status).toBe(413)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "CONSOLE_REQUEST_INVALID", docs: expect.stringMatching(/^https:\/\//), message: "Console request body exceeds the byte limit.", ok: false, status: 413 })
  })

  it("cancels oversized ordinary envelopes before reading the remaining body", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode(operationRpcBody("sections.list").padEnd(32 * 1_024, " ")),
      encoder.encode(" ".repeat(32 * 1_024)),
      encoder.encode(" "),
      encoder.encode(" ".repeat(32 * 1_024)),
    ]
    const cancel = vi.fn()
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        const chunk = chunks[reads++]
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
    }, { highWaterMark: 0 })
    const response = await handleConsoleRpcRequest(new Request(callURL, {
      body,
      duplex: "half",
      headers: { [consoleRpcHeader]: "1" },
      method: "POST",
    } as RequestInit))
    expect(response.status).toBe(413)
    expect(cancel).toHaveBeenCalledOnce()
    expect(reads).toBe(3)
  })

  it("counts UTF-8 bytes for non-invocation envelopes", async () => {
    const body = operationRpcBody("sections.list", { prompt: "é".repeat(40 * 1_024) })
    expect(body.length).toBeLessThan(64 * 1_024)
    expect((await call(body)).status).toBe(413)
  })

  it("keeps the invocation allowance for an operation-only envelope", async () => {
    const envelope = operationRpcBody("agents.invoke")
    const response = await call(envelope.padEnd(80 * 1_024, " "))
    expect(response.status).toBe(400)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "INTERNAL_R0022", ok: false, status: 400 })
  })

  it("keeps the larger allowance for invocation envelopes", async () => {
    const response = await call(operationRpcBody("agents.invoke", { prompt: "x".repeat(80 * 1_024) }))
    expect(response.status).toBe(400)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "INTERNAL_R0022", message: expect.stringContaining("Invalid input for agents.invoke"), ok: false, status: 400 })
  })

  it("classifies invocation prefixes split across stream chunks", async () => {
    const envelope = operationRpcBody("agents.invoke", { prompt: "x".repeat(80 * 1_024) })
    const bytes = new TextEncoder().encode(envelope)
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close()
        else {
          controller.enqueue(bytes.subarray(offset, offset + 1_024))
          offset = Math.min(offset + 1_024, bytes.length)
        }
      },
    })
    const response = await handleConsoleRpcRequest(new Request(callURL, {
      body,
      duplex: "half",
      headers: { [consoleRpcHeader]: "1" },
      method: "POST",
    } as RequestInit))
    expect(response.status).toBe(400)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "INTERNAL_R0022" })
  })

  it.each([
    { a: [{ prompt: "x".repeat(80 * 1_024) }], m: "agents.invoke", t: "q", i: "1" },
    { m: "sections.list", a: [{ prompt: "x".repeat(80 * 1_024) }], t: "q", i: "1" },
  ])("requires a leading invocation method before allowing a large body", async (envelope) => {
    expect((await call(JSON.stringify(envelope))).status).toBe(413)
  })

  it("rejects a duplicate method name after a leading invocation method", async () => {
    const invocation = operationRpcBody("agents.invoke", { prompt: "x".repeat(80 * 1_024) })
    const duplicate = `${invocation.slice(0, -1)}, "m": ${JSON.stringify("sections.list")}}`
    expect((await call(duplicate)).status).toBe(400)
  })

  it("caps invocation bodies after selecting the larger allowance", async () => {
    const envelope = operationRpcBody("agents.invoke", { prompt: "x".repeat(16 * 1_024 * 1_024) })
    expect((await call(envelope)).status).toBe(413)
  })
})
