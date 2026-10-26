import { H3Event } from "h3"
import { createApp, createRouter, eventHandler, toWebHandler } from "h3-v1"
import { describe, expect, it, vi } from "vitest"
import { createConsoleAppAuthAccess } from "../src/console/auth.ts"
import { consoleEventPath } from "../src/console/auth-path.ts"
import { handleCloudflareAccessConsoleRequest } from "../src/console/auth-cloudflare-access.ts"

/** The H3 1 event that Nitro 2 gives a Nuxt 4 handler: an own `node` field, a `req` getter that is the Node request, and no `url`. */
class H3V1Event {
  readonly __is_event__ = true
  readonly context: Record<string, unknown> = {}
  readonly node: { req: Record<string, unknown>, res: Record<string, unknown> }

  constructor(url: string, init: { headers?: Record<string, string>, method?: string } = {}) {
    this.node = {
      req: { headers: { host: "app.example.com", ...init.headers }, method: init.method ?? "GET", socket: {}, url, async* [Symbol.asyncIterator]() {} },
      res: {},
    }
  }

  get req(): Record<string, unknown> {
    return this.node.req
  }
}

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
  it.each(["H3 1", "H3 2", "Request"])("authorizes canonical paths for %s", async (kind) => {
    const request = new Request("https://app.example.com/_%76itehub/rpc/__call", { method: "POST" })
    const event = kind === "H3 1" ? new H3V1Event("/_%76itehub/rpc/__call", { method: "POST" }) : kind === "H3 2" ? new H3Event(request) : request
    const { access, requireAuthAccessRoutes, requireSession } = appAccess()
    await access.check(event)
    expect(requireAuthAccessRoutes).toHaveBeenCalledWith(event, [0], undefined, [0], { redirectToSignIn: false })
    expect(requireSession).not.toHaveBeenCalled()
    expect((await handleCloudflareAccessConsoleRequest(event, () => ({ audience: "aud", teamDomain: "team.cloudflareaccess.com" })))?.status).toBe(401)
    expect(request.url).toContain("_%76itehub")
  })
  it("protects the handler selected by H3 1 after decoding an encoded question mark", async () => {
    const { access, requireAuthAccessRoutes, requireSession } = appAccess()
    const app = createApp()
    const router = createRouter()
    router.get("/_vitehub", eventHandler(async (event) => {
      await access.check(event)
      return await handleCloudflareAccessConsoleRequest(event, () => ({ audience: "aud", teamDomain: "team.cloudflareaccess.com" }))
    }))
    app.use(router)
    const response = await toWebHandler(app)(new Request("https://app.example.com/_%76itehub%3Fignored"))
    expect(response.status).toBe(401)
    expect(requireAuthAccessRoutes).toHaveBeenCalledWith(expect.anything(), [0], undefined, [0], { redirectToSignIn: false })
    expect(requireSession).not.toHaveBeenCalled()
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
})
