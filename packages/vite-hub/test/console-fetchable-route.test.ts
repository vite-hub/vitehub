import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleRequestError, consoleRoute } from "../src/console/runtime/server/request.ts"
import statusRoute from "../src/console/runtime/server/status.get.ts"

afterEach(() => {
  installConsoleAccess({ mode: "open" })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Fetchable Console routes", () => {
  it("sends a value as JSON with the Console response headers, and a Response as it is", async () => {
    const value = await consoleRoute(() => ({ ok: 1 })).fetch(new Request("http://app.test/api/_vitehub/console/x"))
    expect(value.status).toBe(200)
    expect(value.headers.get("cache-control")).toBe("no-store")
    expect(value.headers.get("x-content-type-options")).toBe("nosniff")
    expect(value.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    await expect(value.json()).resolves.toEqual({ ok: 1 })
    const own = new Response("raw", { status: 418 })
    expect(await consoleRoute(() => own).fetch(new Request("http://app.test/x"))).toBe(own)
  })

  it("preserves an access Response created before the host replaces the global constructor", async () => {
    const rejection = new Response("Sign in", { headers: { "www-authenticate": "Bearer" }, status: 401 })
    // A server can replace the global Response after an integration captures the native constructor.
    class ServerResponse extends Response {}
    vi.stubGlobal("Response", ServerResponse)
    installConsoleAccess({ mode: "open", authorize: () => rejection })

    const response = await statusRoute.fetch(new Request("http://app.test/api/_vitehub/console/status"))
    expect(response).toBe(rejection)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer")
    await expect(response.text()).resolves.toBe("Sign in")
  })

  it("gives the handler the Request, with a Standard Context when the host set none", async () => {
    const request = new Request("http://app.test/x")
    let seen: unknown
    await consoleRoute((event) => {
      seen = event
      return {}
    }).fetch(request)
    expect(seen).toBe(request)
    expect(request).toHaveProperty("~standard.req", request)
  })

  it("answers a Console request error with its status and Console diagnostic fields", async () => {
    const response = await consoleRoute(() => {
      throw consoleRequestError(405, "Method not allowed")
    }).fetch(new Request("http://app.test/x", { method: "POST" }))
    expect(response.status).toBe(405)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_REQUEST_INVALID", fix: expect.any(String), message: "Method not allowed", ok: false, status: 405 })
  })

  it("answers an unexpected failure with 500, logs it, and keeps its message out of the response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const response = await consoleRoute(() => {
      throw new Error("secret provider detail")
    }).fetch(new Request("http://app.test/x"))
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).not.toContain("secret provider detail")
    expect(JSON.parse(body)).toMatchObject({ code: "CONSOLE_REQUEST_FAILED", ok: false, status: 500 })
    expect(log).toHaveBeenCalledOnce()
  })

  it("serves the status route through an H3 router below an app base, as Nitro 3 mounts it", async () => {
    installConsoleSections("/console-route-test", ["agents"])
    const app = new H3().get("/portal/api/_vitehub/console/status", statusRoute)
    const ok = await app.fetch(new Request("http://app.test/portal/api/_vitehub/console/status"))
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("no-store")
    await expect(ok.json()).resolves.toEqual({ agents: [], observability: null })
    const invalid = await app.fetch(new Request(`http://app.test/portal/api/_vitehub/console/status?agent=${"a".repeat(600)}`))
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ code: "VITE_HUB_R0113", message: "Invalid Agent name.", status: 400 })
    installConsoleAccess({ mode: "open", authorize: () => false })
    const denied = await app.fetch(new Request("http://app.test/portal/api/_vitehub/console/status"))
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ code: "CONSOLE_ACCESS_DENIED" })
  })
})
