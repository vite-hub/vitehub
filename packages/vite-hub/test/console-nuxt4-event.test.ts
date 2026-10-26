import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createConsoleAppAuthAccess } from "../src/console/auth.ts"
import { handleCloudflareAccessConsoleRequest, verifyCloudflareAccessConsoleRequest } from "../src/console/auth-cloudflare-access.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"

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

describe("Console access on an H3 1 event (Nuxt 4)", () => {
  it("matches the app Auth routes by the path of an event with no url", async () => {
    const { access, requireAuthAccessRoutes, requireSession } = appAccess()
    const rpc = new H3V1Event("/_vitehub/rpc/__call", { method: "POST" })
    expect("url" in rpc).toBe(false)
    await access.check(rpc)
    expect(requireAuthAccessRoutes).toHaveBeenCalledWith(rpc, [0], undefined, [0], { redirectToSignIn: false })
    await access.check(new H3V1Event("/api/_vitehub/console/status"))
    expect(requireAuthAccessRoutes).toHaveBeenLastCalledWith(expect.anything(), [1], undefined, [], { redirectToSignIn: false })
    // A route with a method matches only that method; any other Console path needs a session.
    await access.check(new H3V1Event("/api/_vitehub/console/status", { method: "POST" }))
    expect(requireSession).toHaveBeenCalledTimes(1)
  })

  it("reads the Console user from the headers of the Node request", async () => {
    const { access, getSession } = appAccess()
    await expect(access.user(new H3V1Event("/_vitehub", { headers: { cookie: "session=1" } }))).resolves.toEqual({ id: "ada" })
    await expect(access.user(new H3V1Event("/_vitehub"))).resolves.toBeUndefined()
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it("still reads an H3 2 event", async () => {
    const { access, requireAuthAccessRoutes } = appAccess()
    const event = { req: new Request("https://app.example.com/_vitehub/rpc/__call", { method: "POST" }), url: new URL("https://app.example.com/_vitehub/rpc/__call") }
    await access.check(event)
    expect(requireAuthAccessRoutes).toHaveBeenCalledWith(event, [0], undefined, [0], { redirectToSignIn: false })
  })

  it("guards the Cloudflare Access routes of an event with no url", async () => {
    const settings = () => ({ audience: "aud", teamDomain: "team.cloudflareaccess.com" })
    const verify = vi.fn(async () => ({ email: "maintainer@example.com" }))
    const headers = { "cf-access-jwt-assertion": "token" }
    expect(await handleCloudflareAccessConsoleRequest(new H3V1Event("/api/app"), settings, "/", verify)).toBeUndefined()
    expect(verify).not.toHaveBeenCalled()
    expect((await handleCloudflareAccessConsoleRequest(new H3V1Event("/_vitehub/rpc/__call", { method: "POST" }), settings, "/", verify))?.status).toBe(401)
    expect(await handleCloudflareAccessConsoleRequest(new H3V1Event("/_vitehub", { headers }), settings, "/", verify)).toBeUndefined()
    const identity = await handleCloudflareAccessConsoleRequest(new H3V1Event("/portal/api/_vitehub/console/auth/identity", { headers }), settings, "/portal/", verify)
    expect(await identity?.json()).toMatchObject({ email: "maintainer@example.com" })
    expect(await verifyCloudflareAccessConsoleRequest(new H3V1Event("/api/_vitehub/console/status"), settings, verify)).toMatchObject({ status: 401 })
  })

  it("generates a Console plugin that does not read event.url", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-nuxt4-"))
    try {
      const file = join(root, "console.mjs")
      await writeConsoleNitroPlugin(file, root, [], [], { agents: [], content: {} }, [], [], undefined, undefined, false, undefined, () => true, undefined, false, undefined, { check: { appRoutes: routes }, mode: "auth" })
      const generated = await readFile(file, "utf8")
      expect(generated).toContain("vitehubCreateConsoleAppAuthAccess({ routes:")
      expect(generated).not.toContain("event.url")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
