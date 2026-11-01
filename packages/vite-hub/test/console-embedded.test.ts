import { afterEach, describe, expect, it, vi } from "vitest"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import page from "../src/console/runtime/server/page.get.ts"
import session from "../src/console/runtime/server/page-session.ts"

const event = (path: string) => ({ method: "GET", req: new Request(`http://localhost${path}`) })
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
})

describe("embedded Console access", () => {
  it("allows same-origin production framing only after the Console allows the request", async () => {
    installConsoleAccess({ mode: "open", authorize: async () => false })
    expect((await page(event("/_vitehub?embed=1"))).headers.get("x-frame-options")).toBe("DENY")
    installConsoleAccess({ mode: "open", authorize: async () => true })
    expect((await page(event("/_vitehub"))).headers.get("x-frame-options")).toBe("DENY")
    const allowed = await page(event("/_vitehub?embed=1"))
    expect(allowed.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(allowed.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
    expect(allowed.headers.get("content-security-policy")).toContain("frame-src 'self'")
    expect(allowed.headers.get("content-security-policy")).toContain("form-action 'self'")
    expect(allowed.headers.get("cache-control")).toBe("no-store")
  })

  it.each([
    { mode: "open", signInPage: undefined },
    { mode: "open", signInPage: "/sign-in" },
    { mode: "auth", signInPage: undefined },
    { mode: "auth", signInPage: "/sign-in" },
    { mode: "cloudflare-access", signInPage: undefined },
    { mode: "cloudflare-access", signInPage: "/sign-in" },
  ] as const)("reuses the page grant for framing with $mode access and signInPage=$signInPage", async ({ mode, signInPage }) => {
    const authorize = vi.fn(() => false).mockReturnValueOnce(true)
    const check = vi.fn(async () => undefined)
    const policy = mode === "open" ? { mode, authorize } : { mode, check, authorize }
    installConsoleAccess({ ...policy, ...(signInPage ? { signInPage } : {}) })

    const allowed = await page(event("/_vitehub?embed=1"))
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(allowed.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(mode === "open" ? 0 : 1)

    const denied = await page(event("/_vitehub?embed=1"))
    expect(denied.status).toBe(403)
    expect(denied.headers.get("x-frame-options")).toBe("DENY")
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenCalledTimes(mode === "open" ? 0 : 2)
  })

  it("keeps a signed-out embedded page unframeable without repeating authentication", async () => {
    const check = vi.fn(async () => new Response(null, { status: 401 }))
    const authorize = vi.fn(() => true)
    installConsoleAccess({ mode: "auth", check, authorize })

    const signedOut = await page(event("/_vitehub?embed=1"))
    expect(signedOut.status).toBe(200)
    expect(signedOut.headers.get("x-frame-options")).toBe("DENY")
    expect(signedOut.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(check).toHaveBeenCalledTimes(1)
    expect(authorize).not.toHaveBeenCalled()
  })

  it("does not offer Content to a Console user whose sections exclude it", async () => {
    installConsoleSections("/embedded-test", ["content", "kv"])
    const app = { fetch: (request: Request) => session({ method: "GET", req: request }) }
    installConsolePageTool(app)
    installConsoleAccess({ mode: "open", authorize: async () => ({ sections: ["kv"] }) })
    expect(await (await app.fetch(event("/_vitehub/page/session").req)).json()).toMatchObject({ tools: [{ id: "console" }] })
    installConsoleAccess({ mode: "open", authorize: async () => ({ sections: ["content"] }) })
    expect(await (await app.fetch(event("/_vitehub/page/session").req)).json()).toMatchObject({ tools: [{ id: "console" }, { id: "content", lazy: true }] })
  })

  it("keeps read-only Content in Console without replacing the writable Comments inline editor", async () => {
    installConsoleSections("/embedded-test", ["content", "comments"])
    const app = { fetch: (request: Request) => session({ method: "GET", req: request }) }
    installConsolePageTool(app)
    installConsoleAccess({ mode: "open", authorize: async () => ({ sections: ["comments", "content:read"] }) })
    const response = await app.fetch(event("/_vitehub/page/session").req)
    expect(await response.json()).toMatchObject({ tools: [{ id: "console" }] })
  })
})
