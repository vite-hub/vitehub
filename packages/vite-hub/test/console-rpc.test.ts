import { afterEach, describe, expect, it, vi } from "vitest"

import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { inspectServerEnv } from "@vite-hub/env"
import { installConsoleEnv } from "../src/console/runtime/server/env.ts"

import { requestConsole } from "../src/console/runtime/client/request.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import consoleRpcHandler, { handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts"
import { installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"

const callURL = "http://vitehub.local/_vitehub/rpc/__call"

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
})

describe("Console RPC", () => {
  it("preserves request bindings through Env status inspection", async () => {
    installConsoleSections("/console-rpc-env", ["env"])
    const binding = "request-only-secret"
    installConsoleEnv("/console-rpc-env", { entries: [] }, undefined, async event => {
      expect(getCloudflareEnv(event, { fallback: false })).toEqual({ RPC_TOKEN: binding })
      return inspectServerEnv({ token: { required: true, schema: { kind: "string" }, secret: true, source: { kind: "env", label: "env:RPC_TOKEN", name: "RPC_TOKEN", serializable: true } } }, event)
    })
    const request = Object.assign(new Request(callURL, {
      body: JSON.stringify({ input: { query: { status: "1" } }, method: consoleRpcMethods.env }),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }), { runtime: { name: "cloudflare", cloudflare: { context: { waitUntil: vi.fn(), passThroughOnException: vi.fn() }, env: { RPC_TOKEN: binding } } } })
    const response = await consoleRpcHandler.fetch(request)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, value: { status: [{ status: "available", blocking: false }] } })
    expect(JSON.stringify(body)).not.toContain(binding)
  })

  it("serves consecutive calls from different handler instances", async () => {
    installConsoleSections("/console-rpc-test", ["agents", "usage"])
    installConsoleProjectName("/console-rpc-test", "Stateless Console")
    vi.resetModules()
    // A fresh module graph has no state from the first handler, like a second Worker isolate.
    const { default: secondHandler } = await import("../src/console/runtime/server/rpc.ts")
    expect(secondHandler).not.toBe(consoleRpcHandler)
    const instances = [consoleRpcHandler, secondHandler]
    let next = 0
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(input, "http://vitehub.local"), init)
      expect(request.headers.get(consoleRpcHeader)).toBe("1")
      return instances[next++ % instances.length]!.fetch(request)
    })

    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(requestConsole("/api/_vitehub/console/sections"))
        .resolves.toEqual({ projectName: "Stateless Console", sections: ["agents", "usage"] })
    }
    expect(next).toBe(4)
    await expect(requestConsole("/api/_vitehub/console/definitions"))
      .rejects.toMatchObject({ message: "A valid definition section is required.", name: "ConsoleRequestError", status: 400 })
  })

  it("returns operation results and errors with no-store headers", async () => {
    installConsoleSections("/console-rpc-test", ["agents"])
    const success = await call(JSON.stringify({ input: {}, method: consoleRpcMethods.sections }))
    expect(success.status).toBe(200)
    expect(success.headers.get("cache-control")).toBe("no-store")
    expect(success.headers.get("x-content-type-options")).toBe("nosniff")
    expect(success.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    await expect(success.json()).resolves.toMatchObject({ ok: true, value: { sections: ["agents"] } })

    const failure = await call(JSON.stringify({ method: consoleRpcMethods.definitions }))
    expect(failure.status).toBe(400)
    await expect(failure.json()).resolves.toEqual({ message: "A valid definition section is required.", ok: false, status: 400 })
  })

  it("preserves upstream search status messages in RPC errors", async () => {
    const response = await call(JSON.stringify({
      input: { query: { search: "x".repeat(257) } },
      method: consoleRpcMethods.search,
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      message: "Console search must be at most 256 characters.",
      ok: false,
      status: 400,
    })
  })

  it("rejects malformed calls before running an operation", async () => {
    const cases: Array<[Promise<Response>, number]> = [
      [handleConsoleRpcRequest(new Request(callURL, { headers: { [consoleRpcHeader]: "1" } })), 405],
      [handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__sse", { body: "{}", headers: { [consoleRpcHeader]: "1" }, method: "POST" })), 404],
      [handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/other/_vitehub/rpc/__call", { body: "{}", headers: { [consoleRpcHeader]: "1" }, method: "POST" })), 404],
      [handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call/child", { body: "{}", headers: { [consoleRpcHeader]: "1" }, method: "POST" })), 404],
      [call("{"), 400],
      [call(JSON.stringify([])), 400],
      [call(JSON.stringify({ method: "__proto__" })), 404],
      [call(JSON.stringify({ method: "constructor" })), 404],
      [call(JSON.stringify({ input: [], method: consoleRpcMethods.sections })), 400],
      [call(JSON.stringify({ input: { query: { limit: 10 } }, method: consoleRpcMethods.sections })), 400],
      [call(JSON.stringify({ input: { method: "DELETE" }, method: consoleRpcMethods.sections })), 400],
    ]
    for (const [pending, status] of cases) {
      const response = await pending
      expect(response.status).toBe(status)
      expect(response.headers.get("cache-control")).toBe("no-store")
      await expect(response.json()).resolves.toMatchObject({ ok: false, status })
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
        body: method === "POST" ? JSON.stringify({ method: consoleRpcMethods.sections }) : undefined,
        headers,
        method,
      }))
      expect(response.status).toBe(403)
      expect(response.headers.has("access-control-allow-origin")).toBe(false)
      await expect(response.json()).resolves.toEqual({ message: "Forbidden", ok: false, status: 403 })
    }
  })

  it.each([
    { origin: "https://vitehub.local" },
    { "sec-fetch-site": "same-origin" },
    { origin: "https://vitehub.local", "sec-fetch-site": "same-origin" },
    { [consoleRpcHeader]: "1" },
  ])("accepts same-origin evidence or the marker under a mounted Console path: %j", async (headers) => {
    installConsoleSections("/console-rpc-test", ["agents"])
    const response = await handleConsoleRpcRequest(new Request("https://vitehub.local/tools/_vitehub/rpc/__call", {
      body: JSON.stringify({ method: consoleRpcMethods.sections }),
      headers,
      method: "POST",
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, value: { sections: ["agents"] } })
  })

  it("accepts browser same-origin metadata behind TLS termination", async () => {
    const response = await handleConsoleRpcRequest(new Request(callURL, {
      body: JSON.stringify({ method: consoleRpcMethods.sections }),
      headers: { origin: "https://vitehub.local", "sec-fetch-site": "same-origin" },
      method: "POST",
    }))
    expect(response.status).toBe(200)
  })

  it("limits the complete call body", async () => {
    const oversized = await call(JSON.stringify({ input: { body: "x".repeat(16 * 1_024 * 1_024) }, method: consoleRpcMethods.agentInvocations }))
    expect(oversized.status).toBe(413)
    await expect(oversized.json()).resolves.toEqual({ message: "Console request body exceeds the byte limit.", ok: false, status: 413 })
  })

  it("enforces the non-invocation limit on raw envelope bytes", async () => {
    const envelope = JSON.stringify({ method: consoleRpcMethods.sections })
    const body = envelope.padEnd(64 * 1_024, " ")
    expect((await call(body)).status).toBe(200)
    const response = await call(`${body} `)
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ message: "Console request body exceeds the byte limit.", ok: false, status: 413 })
  })

  it("cancels oversized ordinary envelopes before reading the remaining body", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode(JSON.stringify({ method: consoleRpcMethods.sections }).padEnd(32 * 1_024, " ")),
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
    const body = JSON.stringify({ input: { body: "é".repeat(40 * 1_024) }, method: consoleRpcMethods.sections })
    expect(body.length).toBeLessThan(64 * 1_024)
    expect((await call(body)).status).toBe(413)
  })

  it("keeps the invocation allowance for a method-only envelope", async () => {
    const envelope = JSON.stringify({ method: consoleRpcMethods.agentInvocations })
    const response = await call(envelope.padEnd(80 * 1_024, " "))
    expect(response.status).toBe(405)
    await expect(response.json()).resolves.toEqual({ message: "Method not allowed", ok: false, status: 405 })
  })

  it("keeps the larger allowance for invocation envelopes", async () => {
    const response = await call(JSON.stringify({ method: consoleRpcMethods.agentInvocations, input: { body: "x".repeat(80 * 1_024), method: "POST" } }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ message: "Missing Agent name.", ok: false, status: 400 })
  })

  it("classifies invocation prefixes split across stream chunks", async () => {
    const envelope = JSON.stringify({ method: consoleRpcMethods.agentInvocations, input: { body: "x".repeat(80 * 1_024), method: "POST" } })
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
    await expect(response.json()).resolves.toMatchObject({ message: "Missing Agent name." })
  })

  it.each([
    { input: { body: "x".repeat(80 * 1_024) }, method: consoleRpcMethods.agentInvocations },
    { input: { method: consoleRpcMethods.agentInvocations, body: "x".repeat(80 * 1_024) }, method: consoleRpcMethods.sections },
  ])("requires a leading invocation method before allowing a large body", async (envelope) => {
    expect((await call(JSON.stringify(envelope))).status).toBe(413)
  })

  it("rejects a duplicate method after a leading invocation method", async () => {
    const invocation = JSON.stringify({ method: consoleRpcMethods.agentInvocations, input: { body: "x".repeat(80 * 1_024) } })
    const duplicate = `${invocation.slice(0, -1)}, "method": ${JSON.stringify(consoleRpcMethods.sections)}}`
    expect((await call(duplicate)).status).toBe(400)
  })

  it("caps invocation bodies after selecting the larger allowance", async () => {
    const envelope = JSON.stringify({ method: consoleRpcMethods.agentInvocations, input: { body: "x".repeat(16 * 1_024 * 1_024) } })
    expect((await call(envelope)).status).toBe(413)
  })
})
