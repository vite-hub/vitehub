import { consoleBodySha256, createConsoleKeyPair, readConsolePublicKeys, verifyConsoleSignature } from "@vite-hub/internal/console-signature"
import { describe, expect, it, vi } from "vitest"

import { forwardProjectRequest, maxForwardBodyBytes } from "../src/forward.ts"
import { operationRpcBody } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleCaller } from "@vite-hub/internal/console-signature"

const pair = await createConsoleKeyPair()
const caller: ConsoleCaller = { team: { id: "team-1", role: "owner" }, user: { email: "ada@example.com", id: "user-1", name: "Ada" }, via: "console" }
const target = { caller, key: { name: "CONSOLE_3F9A12BC", privateKey: pair.privateKey }, url: "https://app.example.com/portal" }

function upstream(response: Response = Response.json({ ok: true })) {
  return vi.fn<typeof fetch>(async () => response)
}

function call(init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request("https://console.example.com/p/1/_vitehub/rpc", { method: "POST", body: "{}", ...init })
}

describe("forwardProjectRequest", () => {
  it("signs the call for the person, and sends no cookie, Origin, or Authorization of the page", async () => {
    const send = upstream()
    const body = operationRpcBody("project.get", {})
    const response = await forwardProjectRequest(call({
      body,
      headers: { "authorization": "Bearer page", "content-type": "application/json", "cookie": "session=1", "origin": "https://console.example.com", "x-vitehub-console": "1" },
    }), target, "/_vitehub/rpc?x=1", send)
    expect(response.status).toBe(200)
    const [url, init] = send.mock.calls[0]!
    expect(String(url)).toBe("https://app.example.com/portal/_vitehub/rpc?x=1")
    const headers = new Headers(init?.headers)
    // The app verifies the signature with the public key of the link, over the exact bytes that it receives.
    const keys = readConsolePublicKeys({ VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC: pair.publicKey })
    if (!(keys instanceof Map)) throw new Error(keys.message)
    const sent = new Uint8Array(await new Response(init?.body).arrayBuffer())
    await expect(verifyConsoleSignature({ headers, keys, method: "POST", origin: "https://app.example.com", url: String(url) })).resolves.toEqual({
      bodySha256: await consoleBodySha256(sent),
      caller,
      key: "CONSOLE_3F9A12BC",
      ok: true,
    })
    expect(new TextDecoder().decode(sent)).toBe(body)
    expect(headers.has("authorization")).toBe(false)
    expect(headers.get("x-vitehub-console")).toBe("1")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.has("cookie")).toBe(false)
    expect(headers.has("origin")).toBe(false)
    expect(init?.redirect).toBe("manual")
    expect(init?.method).toBe("POST")
  })

  it("sends the Console route", async () => {
    const send = upstream()
    expect((await forwardProjectRequest(call(), target, "/_vitehub/rpc", send)).status).toBe(200)
  })

  it.each([
    "/_vitehub",
    "/_vitehub/",
    "/_vitehub/kv",
    "/_vitehub/sign-in",
    "/_vitehub/mcp",
    "/_vitehub/api/env/manage",
    "/_vitehub/env/manage",
    "/_vitehub/page/session",
    "/_vitehub/auth/manage",
    "/_vitehub/rpc/__call",
    "/api/users",
    "/_vitehub/api/../../admin",
    "/_vitehub/api/%2e%2e/%2e%2e/admin",
    "//evil.example.com/_vitehub/rpc",
  ])("does not send %s", async (path) => {
    const send = upstream()
    const response = await forwardProjectRequest(call(), target, path, send)
    expect(response.status).toBe(404)
    expect(send).not.toHaveBeenCalled()
  })

  it.each(["GET", "PUT", "DELETE", "PATCH"])("does not send %s", async (method) => {
    const send = upstream()
    const request = new Request("https://console.example.com/p/1/_vitehub/rpc", { method, ...(method === "GET" ? {} : { body: "{}" }) })
    expect((await forwardProjectRequest(request, target, "/_vitehub/rpc", send)).status).toBe(405)
    expect(send).not.toHaveBeenCalled()
  })

  it("sends a 9 MiB file as base64, and refuses a larger body", async () => {
    const accepted = upstream()
    const file = operationRpcBody("media.upload", { data: Buffer.alloc(9 * 1024 * 1024).toString("base64"), filename: "a.bin", section: "content" })
    expect((await forwardProjectRequest(call({ body: file }), target, "/_vitehub/rpc", accepted)).status).toBe(200)
    const send = upstream()
    const response = await forwardProjectRequest(call({ body: new Uint8Array(maxForwardBodyBytes + 1) }), target, "/_vitehub/rpc", send)
    expect(response.status).toBe(413)
    expect(send).not.toHaveBeenCalled()
  })

  it("keeps the project's status and body, and drops its cookies", async () => {
    const send = upstream(new Response("{\"code\":\"CONSOLE_KEY_UNKNOWN\"}", {
      headers: { "content-type": "application/json", "set-cookie": "a=1", "www-authenticate": "VitehubSignature realm=\"vitehub-console\"" },
      status: 401,
    }))
    const response = await forwardProjectRequest(call(), target, "/_vitehub/rpc", send)
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.has("set-cookie")).toBe(false)
    expect(response.headers.get("www-authenticate")).toBe("VitehubSignature realm=\"vitehub-console\"")
    await expect(response.json()).resolves.toEqual({ code: "CONSOLE_KEY_UNKNOWN" })
  })

  it.each([
    "text/html; charset=utf-8",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/javascript",
    "application/javascript",
    null,
  ])("contains project content with media type %s", async (type) => {
    const body = "<script>fetch('/api/projects')</script>"
    const headers = new Headers({
      "content-disposition": "inline",
      "content-security-policy": "default-src * 'unsafe-inline'",
      "x-content-type-options": "invalid",
    })
    if (type) headers.set("content-type", type)
    const send = upstream(new Response(new TextEncoder().encode(body), { headers }))
    const response = await forwardProjectRequest(call(), target, "/_vitehub/rpc", send)

    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("content-disposition")).toBe("attachment")
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; frame-ancestors 'none'")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    await expect(response.text()).resolves.toBe(body)
  })

  it("keeps binary Operations responses readable by the client", async () => {
    const body = new Uint8Array([0, 255, 60, 62])
    const send = upstream(new Response(body, { headers: { "content-type": "application/octet-stream" } }))
    const response = await forwardProjectRequest(call(), target, "/_vitehub/rpc", send)

    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it("stops at a redirect, so the signed request does not follow it", async () => {
    const send = upstream(new Response(null, { headers: { location: "http://169.254.169.254/" }, status: 302 }))
    const response = await forwardProjectRequest(call(), target, "/_vitehub/rpc", send)
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_FORWARD_REDIRECT" })
  })

  it("says when the project cannot be reached", async () => {
    const send = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed")
    })
    const response = await forwardProjectRequest(call(), target, "/_vitehub/rpc", send)
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_FORWARD_UNREACHABLE", message: "The Console could not reach app.example.com." })
  })
})
