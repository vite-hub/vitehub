import { DatabaseSync } from "node:sqlite"
import { defineAuth } from "@vite-hub/auth"
import { createAuthAccessHandler, createAuthForRequest, requireAuthAccessRoutes } from "@vite-hub/auth/server"
import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleSignInURL } from "../src/console/runtime/client/sign-in.ts"
import { consoleRequest, installConsoleAccess, isConsoleSignInPage } from "../src/console/runtime/server/access.ts"
import consolePageHandler from "../src/console/runtime/server/page.get.ts"
import consoleSignInMiddleware from "../src/console/runtime/server/sign-in.ts"

const origin = "http://vitehub.local"
const unsafePages = ["/..//evil.example/sign-in", "/%2e%2e//evil.example/sign-in"]
const signedOut = () => new Response(null, { status: 401 })
const visit = (path: string) => ({ req: new Request(`${origin}${path}`, { headers: { accept: "text/html" } }) })
const page = (signInPage: string) => ({
  document: { querySelector: () => ({ getAttribute: () => signInPage }) },
  location: new URL(`${origin}/portal/_vitehub/auth?tab=users`),
})

afterEach(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access")) })

describe("Console sign-in URL normalization", () => {
  it.each(unsafePages)("rejects %s before it can become a redirect", (signInPage) => {
    expect(isConsoleSignInPage(signInPage)).toBe(false)
    expect(() => installConsoleAccess({ mode: "open", authorize: signedOut, signInPage })).toThrow("must be a path on the same origin")
  })

  it.each([...unsafePages, "/\\evil.example/sign-in"])("does not link to %s", (signInPage) => {
    expect(consoleSignInURL(page(signInPage))).toBeUndefined()
  })

  it.each(["", "/portal"])("preserves the sign-in fragment below mount %s", async (mount) => {
    installConsoleAccess({ mode: "open", authorize: signedOut, signInPage: "/?from=console#/sign-in" })
    const response = await consolePageHandler(visit(`${mount}/_vitehub/auth?tab=users`))
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`${mount}/?from=console&redirect=${encodeURIComponent(`${mount}/_vitehub/auth?tab=users`)}#/sign-in`)
  })

  it("preserves the sign-in fragment in a client link", () => {
    expect(consoleSignInURL(page("/portal/?from=console#/sign-in"))).toBe("/portal/?from=console&redirect=%2Fportal%2F_vitehub%2Fauth%3Ftab%3Dusers#/sign-in")
  })

  it("normalizes the configured page before adding the mount base", async () => {
    installConsoleAccess({ mode: "open", authorize: signedOut, signInPage: "/../sign-in" })
    const response = await consolePageHandler(visit("/portal/_vitehub/auth"))
    expect(response.headers.get("location")).toBe("/portal/sign-in?redirect=%2Fportal%2F_vitehub%2Fauth")
  })
})

describe("Console sign-in before app Auth", () => {
  it.each(["", "/portal"])("checks signed-in page access once per request below %s", async (mount) => {
    const check = vi.fn(async () => undefined)
    const authorize = vi.fn(() => true)
    installConsoleAccess({ mode: "auth", check, authorize, signInPage: "/sign-in" })
    const app = new H3()
      .use(`${mount}/_vitehub/**`, consoleSignInMiddleware)
      .get(`${mount}/_vitehub/**`, consolePageHandler)

    for (let visits = 1; visits <= 2; visits++) {
      const response = await app.fetch(visit(`${mount}/_vitehub/auth`).req)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('id="app"')
      expect(check).toHaveBeenCalledTimes(visits)
      expect(authorize).toHaveBeenCalledTimes(visits)
    }
  })

  it.each(["", "/portal"])("redirects a signed-out page below %s while Auth still protects data", async (mount) => {
    const database = new DatabaseSync(":memory:")
    try {
      const routes = [{ route: `${mount}/_vitehub/**`, authorize: true }, { route: `${mount}/api/_vitehub/console/**`, authorize: true }] as const
      const definition = defineAuth(() => ({
        access: { routes: routes.map(route => ({ route: route.route, authorize: () => true })) },
        baseURL: origin,
        database,
        secret: "test-secret-at-least-32-bytes-long",
      }))
      const authMiddleware = createAuthAccessHandler(routes, definition)
      installConsoleAccess({
        mode: "auth",
        check: event => requireAuthAccessRoutes(consoleRequest(event), [0], definition, [0], { redirectToSignIn: false }),
        signInPage: "/sign-in",
      })
      const request = visit(`${mount}/_vitehub/auth`).req
      await (await createAuthForRequest(definition, request).$context).runMigrations()
      // Reproduce the rejection that previously prevented the Console page handler from running.
      expect((await authMiddleware(request))?.status).toBe(401)
      const app = new H3()
        .use(`${mount}/_vitehub/**`, consoleSignInMiddleware)
        .use(authMiddleware)
        .get(`${mount}/_vitehub/**`, consolePageHandler)
      const response = await app.fetch(request)
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`${mount}/sign-in?redirect=${encodeURIComponent(`${mount}/_vitehub/auth`)}`)
      for (const [path, method] of [["/_vitehub/rpc/__call", "POST"], ["/api/_vitehub/console/status", "GET"]]) {
        const data = await app.fetch(new Request(`${origin}${mount}${path}`, { method, headers: { accept: "application/json" } }))
        expect(data.status).toBe(401)
        expect(data.headers.get("location")).toBeNull()
      }
    }
    finally { database.close() }
  })

  it("leaves Auth redirects and authorization rejections to the app middleware", async () => {
    for (const status of [302, 403]) {
      installConsoleAccess({ mode: "auth", check: async () => new Response(null, { status }), signInPage: "/sign-in" })
      await expect(consoleSignInMiddleware(visit("/_vitehub/auth"))).resolves.toBeUndefined()
    }
  })
})
