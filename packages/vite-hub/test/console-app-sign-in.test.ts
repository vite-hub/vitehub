import { DatabaseSync } from "node:sqlite"
import { defineAuth } from "@vite-hub/auth"
import { createAuthForRequest, createAuthAccessHandler, requireAuthAccessRoutes } from "@vite-hub/auth/server"
import { H3 } from "h3"
import { afterEach, describe, expect, it } from "vitest"
import { createConsoleAppAuthPages } from "../src/console/auth.ts"
import { installConsoleAccess, consoleRequest } from "../src/console/runtime/server/access.ts"
import signInMiddleware from "../src/console/runtime/server/sign-in.ts"
import consolePage from "../src/console/runtime/server/page.get.ts"

const origin = "https://app.example.com"
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
})

async function setup(mount = "", providers = true) {
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const routes: Parameters<typeof createAuthAccessHandler>[0] = [{ route: `${mount}/_vitehub/**`, authorize: true }, { route: `${mount}/api/_vitehub/console/**`, authorize: true }]
  const definition = defineAuth(() => ({
    baseURL: origin,
    basePath: `${mount}/api/auth`,
    database,
    secret: "test-secret-at-least-32-bytes-long",
    access: { routes: routes.map(route => ({ route: route.route, authorize: () => true })) },
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
    check: event => requireAuthAccessRoutes(consoleRequest(event), [0], definition, [0], { redirectToSignIn: false }),
  })
  const app = new H3()
    .use(`${mount}/_vitehub/**`, signInMiddleware)
    .use(createAuthAccessHandler(routes, definition))
    .get(`${mount}/_vitehub/**`, consolePage)
  return { authForRequest, visit: (path: string, init: RequestInit = {}) => app.fetch(new Request(`${origin}${mount}${path}`, init)) }
}

describe("Console reuses app Auth sign-in", () => {
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
