import { H3Event, normalizeRoute } from "h3"
import { describe, expect, it, vi } from "vitest"
import { createConsoleAppAuthAccess } from "../src/console/auth-pages.ts"
import { consoleEventPath } from "../src/console/auth-path.ts"
import { handleCloudflareAccessConsoleRequest } from "../src/console/auth-cloudflare-access.ts"

const routes = [{ authorize: true, index: 0, route: "/_vitehub/**" }, { authorize: false, index: 1, method: "GET", route: "/api/_vitehub/console/**" }]

function appAccess() {
  const requireAuthAccessRoutes = vi.fn(async () => undefined)
  const requireSession = vi.fn(async () => undefined)
  const getSession = vi.fn(async ({ headers }: { headers: Headers }) => headers.get("cookie") === "session=1" ? { user: { id: "ada" } } : null)
  const access = createConsoleAppAuthAccess({
    getAuthForRequest: () => ({ api: { getSession } }),
    requireAuthAccessRoutes,
    requireSession,
    routes,
  })
  return { access, getSession, requireAuthAccessRoutes, requireSession }
}

describe("Console canonical authorization paths", () => {
  it.each(["H3", "Request"])("authorizes canonical paths for %s", async (kind) => {
    const request = new Request("https://app.example.com/_%76itehub/rpc/__call", { method: "POST" })
    const event = kind === "H3" ? new H3Event(request) : { req: request }
    const { access, requireAuthAccessRoutes, requireSession } = appAccess()
    await access.check(event)
    expect(requireAuthAccessRoutes).toHaveBeenCalledWith(event, [0], undefined, [0], { redirectToSignIn: false, reuse: true })
    expect(requireSession).not.toHaveBeenCalled()
    expect((await handleCloudflareAccessConsoleRequest(event, () => ({ audience: "aud", teamDomain: "team.cloudflareaccess.com" })))?.status).toBe(401)
    expect(request.url).toContain("_%76itehub")
  })
  it("preserves the event pathname after an H3 mount rewrites it", () => {
    const request = new Request("https://app.example.com/portal/_vitehub/rpc/__call")
    const event = new H3Event(request)
    event.url = new URL("https://app.example.com/_vitehub/rpc/__call")
    expect(consoleEventPath(event, request)).toBe("/_vitehub/rpc/__call")
  })

  it.each(["%2F", "%25", "%3F"])("keeps reserved escape %s encoded", (escape) => {
    const request = new Request(`https://app.example.com/_vitehub${escape}rpc`)
    expect(consoleEventPath(request, request)).toBe(new H3Event(request).url.pathname)
  })

  it.each([
    "/_vitehub",
    "/_%76itehub/rpc/__call",
    "/_%56ITEHUB",
    "/_vitehub/%7E%2d%5F%2E%41%7a",
    "/_vitehub/%2e%2e/%2E/admin",
    "/a/.%2E/_vitehub",
    "/_vitehub/x%2e%2e/y",
    "/_vitehub/%C3%A9%20%22%3C",
    "/_vitehub//rpc/",
    "/_vitehub/%252F/%2f/%5C",
  ])("matches H3's route for the bare Request path %s", (path) => {
    const request = new Request(`https://app.example.com${path}`)
    expect(consoleEventPath(request, request)).toBe(normalizeRoute(new URL(request.url).pathname))
  })
})
