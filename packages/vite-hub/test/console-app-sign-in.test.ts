import { DatabaseSync } from "node:sqlite"
import { defineAuth } from "@vite-hub/auth"
import { createAuthForRequest, createAuthAccessHandler, requireAuthAccessRoutes, withAuthorization } from "@vite-hub/auth/server"
import { getAuthForRequest, resetAuth } from "../../auth/src/server.ts"
import { H3, H3Event } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createConsoleAppAuthAccess, createConsoleAppAuthPages, type ConsoleAuthorize } from "../src/console/auth.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import signInMiddleware from "../src/console/runtime/server/sign-in.ts"
import consolePage from "../src/console/runtime/server/page.get.ts"

const origin = "https://app.example.com"
vi.mock("../../auth/dist/runtime/empty-definition.js", () => ({
  default: { options: {
    appName: "Static Console App",
    secret: "test-secret-at-least-32-bytes-long",
    basePath: "/portal/api/auth",
    socialProviders: { github: { clientId: "test-github", clientSecret: "test-secret" } },
  } },
}))
const databases: DatabaseSync[] = []
afterEach(() => {
  resetAuth()
  for (const database of databases.splice(0)) database.close()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
})

async function setup(mount = "", providers = true, access: { authorize?: () => boolean, consoleAuthorize?: ConsoleAuthorize } = {}) {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const routes: Parameters<typeof createAuthAccessHandler>[0] = [{ route: `${mount}/_vitehub/**`, authorize: true }, { route: `${mount}/api/_vitehub/console/**`, authorize: true }]
  const definition = defineAuth(() => ({
    baseURL: origin,
    basePath: `${mount}/api/auth`,
    database,
    secret: "test-secret-at-least-32-bytes-long",
    access: { routes: routes.map(route => ({ route: route.route, authorize: access.authorize ?? (() => true) })) },
    emailAndPassword: { enabled: true },
    socialProviders: providers ? {
      github: { clientId: "test-github", clientSecret: "test-secret" },
      google: { clientId: "test-google", clientSecret: "test-secret" },
    } : {},
  }))
  const authForRequest = (request: Pick<Request, "headers" | "url">) => createAuthForRequest(definition, request)
  await (await authForRequest(new Request(origin)).$context).runMigrations()
  installConsoleAccess({
    mode: "auth",
    signInPage: "/_vitehub/sign-in",
    ...createConsoleAppAuthPages(authForRequest),
    ...createConsoleAppAuthAccess({
      getAuthForRequest: authForRequest,
      requireAuthAccessRoutes: (event, indexes, _definition, required, options) => {
        if (!(event instanceof H3Event)) throw new TypeError("Expected the Console's H3 request event.")
        return requireAuthAccessRoutes(event, indexes, definition, required, options)
      },
      requireSession: event => {
        if (!(event instanceof H3Event)) throw new TypeError("Expected the Console's H3 request event.")
        return withAuthorization(true, () => undefined, definition)(event)
      },
      routes: routes.map((route, index) => ({ ...route, index, authorize: true })),
    }),
    authorize: access.consoleAuthorize,
  })
  const app = new H3()
    .use(`${mount}/_vitehub/**`, signInMiddleware)
    .use(createAuthAccessHandler(routes, definition))
    .get(`${mount}/_vitehub/**`, consolePage)
  return { authForRequest, visit: (path: string, init: RequestInit = {}) => app.fetch(new Request(`${origin}${mount}${path}`, init)) }
}

function proxySignInEvent(host: "fetch" | "h3", browserOrigin = origin) {
  const path = "/portal/_vitehub/sign-in?provider=github&redirect=%2Fportal%2F_vitehub%2Fcontent%3Ffile%3Dhome.md"
  const headers = {
    host: "internal:3000",
    origin: browserOrigin,
    "x-forwarded-host": "app.example.com, proxy.internal",
    "x-forwarded-proto": "https, http",
  }
  return host === "fetch"
    ? { req: new Request(`http://internal:3000${path}`, { method: "POST", headers }) }
    : { node: { req: { method: "POST", headers, url: path.slice("/portal".length), originalUrl: path, async *[Symbol.asyncIterator]() {} } } }
}

describe("Console reuses app Auth sign-in", () => {
  it.each([undefined, "text/html"])("checks app and Console authorization once for an accepted page (Accept: %s)", async (accept) => {
    const authorize = vi.fn(() => true)
    const consoleAuthorize = vi.fn(() => true)
    const { authForRequest, visit } = await setup("/portal", true, { authorize, consoleAuthorize })
    const auth = authForRequest(new Request(origin))
    const signedIn = await auth.handler(new Request(`${origin}/portal/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Console User", email: "console@example.com", password: "test-password-123" }),
    }))
    expect(signedIn.status).toBe(200)
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const headers = new Headers({ cookie })
    if (accept) headers.set("accept", accept)
    const response = await visit("/_vitehub/content", { headers })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("<title>ViteHub Console</title>")
    expect(authorize).toHaveBeenCalledOnce()
    expect(consoleAuthorize).toHaveBeenCalledOnce()
  })

  it("rejects a distinct resolved Auth origin before rendering or starting sign-in", async () => {
    const definition = defineAuth(() => ({
      baseURL: "https://auth.example.com",
      secret: "test-secret-at-least-32-bytes-long",
      socialProviders: { github: { clientId: "test-github", clientSecret: "test-secret" } },
    }))
    const pages = createConsoleAppAuthPages(request => createAuthForRequest(definition, request))
    const event = { req: new Request(`${origin}/_vitehub/sign-in?provider=github`, { method: "POST", headers: { origin } }) }
    await expect(pages.authBasePath(event)).rejects.toThrow(/same origin/)
    await expect(pages.signIn(event)).rejects.toThrow(/same origin/)
  })

  it("opens static app Auth before its first HTTP request initializes a base URL", async () => {
    const pages = createConsoleAppAuthPages(getAuthForRequest)
    const event = { req: new Request(`${origin}/portal/_vitehub/sign-in`) }
    await expect(pages.authBasePath(event)).resolves.toBe("/portal/api/auth")
    const response = await pages.signIn(event)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Sign in with GitHub")
    const start = await pages.signIn({ req: new Request(`${origin}/portal/_vitehub/sign-in?provider=github`, { method: "POST", headers: { origin } }) })
    expect(start.status).toBe(303)
    expect(new URL(start.headers.get("location")!).searchParams.get("redirect_uri")).toBe(`${origin}/portal/api/auth/callback/github`)
  })

  it.each(["fetch", "h3"] as const)("uses the public proxy origin for static Auth with %s requests", async (host) => {
    const pages = createConsoleAppAuthPages(getAuthForRequest)
    const event = proxySignInEvent(host)
    await expect(pages.authBasePath(event)).resolves.toBe("/portal/api/auth")
    const response = await pages.signIn(event)
    expect(response.status).toBe(303)
    expect(new URL(response.headers.get("location")!).searchParams.get("redirect_uri")).toBe(`${origin}/portal/api/auth/callback/github`)
    expect((await pages.signIn(proxySignInEvent(host, "https://evil.example"))).status).toBe(403)
  })

  it.each(["fetch", "h3"] as const)("keeps public return and retry URLs behind a proxy with %s requests", async (host) => {
    const { authForRequest } = await setup("/portal")
    const pages = createConsoleAppAuthPages(authForRequest)
    const response = await pages.signIn(proxySignInEvent(host))
    expect(response.status).toBe(303)
    const authorize = new URL(response.headers.get("location")!)
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/portal/api/auth/callback/github`)
    const context = await authForRequest(new Request(origin)).$context
    const state = await context.internalAdapter.findVerificationValue(`auth-state:${authorize.searchParams.get("state")!}`)
    const retry = new URL(`${origin}/portal/_vitehub/sign-in`)
    retry.searchParams.set("redirect", "/portal/_vitehub/content?file=home.md")
    retry.searchParams.set("auth_error", "signin")
    expect(JSON.parse(state!.value)).toMatchObject({
      callbackURL: `${origin}/portal/_vitehub/content?file=home.md`,
      errorURL: retry.href,
    })
  })

  it.each(["", "/portal"])("provides social sign-in before app Auth at %s", async (mount) => {
    const { visit, authForRequest } = await setup(mount)
    const redirect = await visit("/_vitehub/content?file=home.md", { headers: { accept: "text/html" } })
    expect(redirect.status).toBe(302)
    const pageURL = redirect.headers.get("location")!
    expect(pageURL).toBe(`${mount}/_vitehub/sign-in?redirect=${encodeURIComponent(`${mount}/_vitehub/content?file=home.md`)}`)
    const page = await visit(pageURL.slice(mount.length))
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain("Sign in with GitHub")
    expect(html).toContain("Sign in with Google")
    expect(html).toContain('method="post"')
    expect(page.headers.get("cache-control")).toBe("no-store")
    const start = await visit(`${pageURL.slice(mount.length)}&provider=github`, { method: "POST", headers: { origin } })
    expect(start.status).toBe(303)
    const authorize = new URL(start.headers.get("location")!)
    expect(authorize.origin).toBe("https://github.com")
    expect(authorize.searchParams.get("client_id")).toBe("test-github")
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}${mount}/api/auth/callback/github`)
    expect(start.headers.get("set-cookie")).toContain("state")
    const context = await authForRequest(new Request(origin)).$context
    const state = await context.internalAdapter.findVerificationValue(`auth-state:${authorize.searchParams.get("state")!}`)
    expect(JSON.parse(state!.value)).toMatchObject({ callbackURL: `${origin}${mount}/_vitehub/content?file=home.md` })
    const callback = new URL(`${origin}${mount}/api/auth/callback/github`)
    callback.searchParams.set("state", authorize.searchParams.get("state")!)
    callback.searchParams.set("error", "access_denied")
    const cancelled = await authForRequest(new Request(origin)).handler(new Request(callback, {
      headers: { cookie: start.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0]).join("; ") },
    }))
    expect(cancelled.status).toBe(302)
    const retry = new URL(cancelled.headers.get("location")!)
    expect(retry.pathname).toBe(`${mount}/_vitehub/sign-in`)
    expect(retry.searchParams.get("redirect")).toBe(`${mount}/_vitehub/content?file=home.md`)
    expect(await (await visit(`${retry.pathname.slice(mount.length)}${retry.search}`)).text()).toContain("Sign-in failed. Try again.")
    const data = await visit("/_vitehub/rpc/__call", { method: "POST", headers: { accept: "application/json" } })
    expect(data.status).toBe(401)
    expect(data.headers.get("location")).toBeNull()
  })

  it.each(["https://evil.example/", "//evil.example/", "/_vitehub/sign-in", "/admin", "/_vitehub/../../admin", "/\\evil.example/"])("rejects unsafe return path %s", async (redirect) => {
    const { visit, authForRequest } = await setup()
    const start = await visit(`/_vitehub/sign-in?provider=github&redirect=${encodeURIComponent(redirect)}`, { method: "POST", headers: { origin } })
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!
    const context = await authForRequest(new Request(origin)).$context
    expect(JSON.parse((await context.internalAdapter.findVerificationValue(`auth-state:${state}`))!.value).callbackURL).toBe(`${origin}/_vitehub`)
  })

  it("supplies the app Auth base path to the Console account menu", async () => {
    const { authForRequest } = await setup("/portal")
    installConsoleAccess({ mode: "auth", check: async () => undefined, ...createConsoleAppAuthPages(authForRequest) })
    const page = await consolePage({ req: new Request(`${origin}/portal/_vitehub`) })
    expect(await page.text()).toContain('<meta name="vitehub-console-auth-base" content="/portal/api/auth">')
  })

  it("rejects cross-origin login attempts", async () => {
    const { visit } = await setup()
    for (const headers of [{ origin: "https://evil.example" }, {}]) {
      expect((await visit("/_vitehub/sign-in?provider=github", { method: "POST", headers })).status).toBe(403)
    }
  })

  it("shows retry controls for invalid providers and failed callbacks", async () => {
    const { visit } = await setup()
    for (const [path, init] of [
      ["/_vitehub/sign-in?provider=unknown", { method: "POST", headers: { origin } }],
      ["/_vitehub/sign-in?auth_error=signin", {}],
    ] as const) {
      const page = await visit(path, init)
      expect(await page.text()).toContain('role="status">Sign-in failed. Try again.')
    }
  })

  it("explains how to connect an app with no social providers", async () => {
    const { visit } = await setup("", false)
    const page = await visit("/_vitehub/sign-in")
    expect(page.status).toBe(503)
    expect(await page.text()).toContain("console.signInPage")
  })

  it("offers account switching when console.authorize rejects the signed-in account", async () => {
    const { authForRequest } = await setup()
    installConsoleAccess({ mode: "auth", check: async () => undefined, authorize: () => false, signInPage: "/_vitehub/sign-in", ...createConsoleAppAuthPages(authForRequest) })
    const page = await signInMiddleware({ req: new Request(`${origin}/_vitehub`, { headers: { accept: "text/html" } }) })
    expect(page?.status).toBe(403)
    expect(await page?.text()).toContain("Switch account")
  })

  it("uses the app sign-out endpoint when an account is denied", async () => {
    const { authForRequest } = await setup("/portal")
    const { signIn: handler } = createConsoleAppAuthPages(authForRequest)
    const page = await handler({ req: new Request(`${origin}/portal/_vitehub`, { headers: { accept: "text/html" } }) }, new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } }))
    expect(page.status).toBe(403)
    const html = await page.text()
    expect(html).toContain("Switch account")
    expect(html).toContain('fetch("/portal/api/auth/sign-out"')
    expect(html).toContain("/portal/_vitehub/sign-in?denied=1")
  })
})
