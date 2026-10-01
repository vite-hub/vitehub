import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

import { defineAuth } from "@vite-hub/auth"
import type { AuthRuntimeContext } from "@vite-hub/auth"
import { handleAuthRequest, requireAuthAccessRoutes } from "@vite-hub/auth/server"
import { describe, expect, it, vi } from "vitest"
import { build } from "esbuild"
import { resolveConfig } from "vite"

import { consoleAuthPageResponse, consoleAuthSignInPage, createConsoleAuthDefinition, defineConsoleAuth, prepareConsoleAuth } from "../src/console/auth.ts"
import { resolveConsoleAuthConfig, writeConsoleAuthHandlers } from "../src/console/auth-build.ts"
import { createInlineConsoleAuth } from "../src/console/auth-inline.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { installConsoleProjectNameScope, installConsoleSectionScope, resolveConsoleAuth } from "../src/console/internal.ts"

import type { ConsoleInvocationScope } from "../src/console/internal.ts"

describe("independent Console Auth", () => {
  it.each([
    ["", ""],
    ["./", ""],
    ["/portal/", "/portal"],
    ["https://assets.example.com/", ""],
    ["https://assets.example.com/portal/", "/portal"],
  ])("protects session auth routes with base %j", async (base, mount) => {
    const database = new DatabaseSync(":memory:")
    try {
      const input = defineConsoleAuth({
        auth: defineAuth(() => ({ database, secret: "test-secret-at-least-32-bytes-long" })),
        authorize: () => true,
        signIn: { provider: "github" },
      })
      const definition = createConsoleAuthDefinition(input, base)
      if (typeof definition.options !== "function") throw new TypeError("Expected Console Auth options.")
      const options = definition.options({ env: {}, requestOrigin: "https://example.com" })
      expect(options.basePath).toBe(`${mount}/api/_vitehub/console/auth`)
      expect(options.access?.routes).toEqual([
        { route: `${mount}/_vitehub/**`, authorize: input.authorize },
        { route: `${mount}/api/_vitehub/console/**`, authorize: input.authorize },
      ])
      expect(options.access?.signIn?.callbackURL).toBe(`${mount}/_vitehub`)
      for (const path of ["/_vitehub/rpc/__call", "/api/_vitehub/console/status"]) {
        const request = new Request(`https://example.com${mount}${path}`, { method: "POST" })
        await prepareConsoleAuth(input, definition, request)
        expect((await requireAuthAccessRoutes(request, [1], definition, [1]))?.status).toBe(401)
      }
    }
    finally {
      database.close()
    }
  })

  it("reports independent auth only for the configured Console project", () => {
    const scope: ConsoleInvocationScope = {}
    installConsoleSectionScope("/console-auth", ["agents"], scope, true)
    installConsoleProjectNameScope("/console-auth", "Console Auth", scope)
    expect(resolveConsoleAuth(scope)).toBe(true)
    installConsoleSectionScope("/host-managed", ["kv"], scope)
    expect(resolveConsoleAuth(scope)).toBe(false)
  })

  it("uses a distinct base path and cookie prefix and requires a database adapter", () => {
    const database = new DatabaseSync(":memory:")
    try {
      const input = defineConsoleAuth({
        auth: defineAuth(() => ({ database, secret: "test-secret-at-least-32-bytes-long" })),
        authorize: ({ user }) => user.id === "maintainer",
        signIn: { provider: "github" },
      })
      const options = createConsoleAuthDefinition(input).options
      if (typeof options !== "function") throw new TypeError("Expected resolved Console Auth options.")
      const resolved = options({ env: {}, requestOrigin: "https://example.com" })
      expect(resolved.basePath).toBe("/api/_vitehub/console/auth")
      expect(resolved.advanced?.cookiePrefix).toBe("vitehub_console")
      expect(resolved.access?.routes).toHaveLength(2)
      expect(resolved.access?.signIn?.callbackURL).toBe("/_vitehub")
      const mounted = createConsoleAuthDefinition(input, "/portal/").options
      if (typeof mounted !== "function") throw new TypeError("Expected mounted Console Auth options.")
      const mountedOptions = mounted({ env: {}, requestOrigin: "https://example.com" })
      expect(mountedOptions.basePath).toBe("/portal/api/_vitehub/console/auth")
      expect(mountedOptions.access?.signIn?.callbackURL).toBe("/portal/_vitehub")
      expect(mountedOptions.access?.signIn?.errorCallbackURL).toBe("/portal/_vitehub?auth_error=signin")
    }
    finally {
      database.close()
    }
    const metadata = defineConsoleAuth({
      auth: defineAuth(() => ({ database: true, secret: "test-secret-at-least-32-bytes-long" })),
      authorize: () => true,
      signIn: { provider: "github" },
    })
    const options = createConsoleAuthDefinition(metadata).options
    if (typeof options !== "function") throw new TypeError("Expected resolved Console Auth options.")
    expect(() => options({ env: {}, requestOrigin: "https://example.com" })).toThrow("Better Auth database adapter")
  })

  it("accepts a request-scoped secret from the Auth runtime options", async () => {
    const database = new DatabaseSync(":memory:")
    try {
      const input = defineConsoleAuth({
        auth: defineAuth(() => ({
          database,
          runtime: ({ request }: AuthRuntimeContext) => ({ secret: request?.headers.get("x-auth-secret") ?? undefined }),
        })),
        authorize: () => true,
        signIn: { provider: "github" },
      })
      const definition = createConsoleAuthDefinition(input)
      const request = new Request("https://example.com/api/_vitehub/console/status", {
        headers: { "x-auth-secret": "test-secret-at-least-32-bytes-long" },
      })
      await prepareConsoleAuth(input, definition, request)
      const response = await requireAuthAccessRoutes(request, [1], definition, [1])
      expect(response?.status).toBe(401)
      const options = definition.options
      if (typeof options !== "function") throw new TypeError("Expected resolved Console Auth options.")
      expect(() => options({ env: {}, requestOrigin: "https://example.com" })).toThrow("Console Auth requires a secret")
    }
    finally {
      database.close()
    }
  })

  it("discovers committed files and rejects a conflicting explicit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-"))
    try {
      const directory = resolve(root, "vitehub/console/auth")
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, "server.ts"), "export default {}")
      expect(resolveConsoleAuthConfig(root, {})).toEqual({ server: resolve(directory, "server.ts") })
      expect(() => resolveConsoleAuthConfig(root, { server: "custom/auth.ts" })).toThrow("both by path")
      expect(() => resolveConsoleAuthConfig(root, {
        provider: "github",
        allowedEmails: ["user@example.com"],
        databasePath: "/data/console-auth.sqlite",
      })).toThrow("conflicts")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("shows an explicit sign-in page before starting GitHub OAuth", async () => {
    const database = new DatabaseSync(":memory:")
    try {
      const input = defineConsoleAuth({
        auth: defineAuth(() => ({
          database,
          secret: "test-secret-at-least-32-bytes-long",
          socialProviders: { github: { clientId: "test-client", clientSecret: "test-secret" } },
        })),
        authorize: () => false,
        signIn: { provider: "github" },
      })
      const definition = createConsoleAuthDefinition(input)
      const apiRequest = new Request("https://example.com/api/_vitehub/console/status")
      await prepareConsoleAuth(input, definition, apiRequest)
      const apiResponse = await requireAuthAccessRoutes(apiRequest, [1], definition, [1])
      expect(apiResponse?.status).toBe(401)
      const pageRequest = new Request("https://example.com/_vitehub", { headers: { accept: "text/html" } })
      const pageResponse = await requireAuthAccessRoutes(pageRequest, [0], definition, [0], { redirectToSignIn: false })
      expect(pageResponse?.status).toBe(401)
      const signInRedirect = consoleAuthPageResponse(pageRequest, pageResponse)
      expect(signInRedirect?.status).toBe(302)
      expect(signInRedirect?.headers.get("location")).toBe("https://example.com/_vitehub/sign-in")
      const signInPage = consoleAuthSignInPage("github", new Request("https://example.com/_vitehub/sign-in"))
      expect(signInPage.status).toBe(200)
      const html = await signInPage.text()
      expect(html).toContain("Sign in with GitHub")
      expect(html).toContain('href="/_vitehub?auth_start=1"')
      expect(html).not.toContain("<form")
      expect(html).not.toContain("github.com/login/oauth")

      const explicitRequest = new Request("https://example.com/_vitehub?auth_start=1", { headers: { accept: "text/html" } })
      const explicitResponse = await requireAuthAccessRoutes(explicitRequest, [0], definition, [0])
      expect(explicitResponse?.status).toBe(302)
      expect(explicitResponse?.headers.get("location")).toContain("github.com")
      expect(explicitResponse?.headers.get("location")).toContain("api%2F_vitehub%2Fconsole%2Fauth%2Fcallback%2Fgithub")
    }
    finally {
      database.close()
    }
  })

  it("lets a denied signed-in account switch accounts without opening Console APIs", async () => {
    const database = new DatabaseSync(":memory:")
    try {
      const input = defineConsoleAuth({
        auth: defineAuth(() => ({
          baseURL: "https://example.com",
          database,
          emailAndPassword: { enabled: true },
          secret: "test-secret-at-least-32-bytes-long",
          socialProviders: { github: { clientId: "test-client", clientSecret: "test-secret" } },
        })),
        authorize: ({ user }) => user.email === "allowed@example.com",
        signIn: { provider: "github" },
      })
      const definition = createConsoleAuthDefinition(input, "/portal/")
      const signUp = new Request("https://example.com/portal/api/_vitehub/console/auth/sign-up/email", {
        body: JSON.stringify({ email: "denied@example.com", name: "Denied User", password: "passwordpassword" }),
        headers: { "content-type": "application/json", origin: "https://example.com" },
        method: "POST",
      })
      await prepareConsoleAuth(input, definition, signUp)
      const signUpResponse = await handleAuthRequest(definition, signUp)
      expect(signUpResponse.status).toBe(200)
      const cookie = signUpResponse.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      expect(cookie).toContain("vitehub_console.session_token")

      const pageRequest = new Request("https://example.com/portal/_vitehub", {
        headers: { accept: "text/html", cookie },
      })
      const denied = await requireAuthAccessRoutes(pageRequest, [0], definition, [0])
      expect(denied?.status).toBe(403)
      const page = consoleAuthPageResponse(pageRequest, denied, "/portal/")
      expect(page?.status).toBe(403)
      expect(page?.headers.get("content-security-policy")).toContain("script-src 'nonce-")
      const html = await page?.text()
      expect(html).toContain("Switch account")
      expect(html).toContain('fetch("/portal/api/_vitehub/console/auth/sign-out"')
      expect(html).toContain('window.location.assign("/portal/_vitehub/sign-in?denied=1")')

      const apiRequest = new Request("https://example.com/portal/api/_vitehub/console/status", {
        headers: { accept: "application/json", cookie },
      })
      const apiDenied = await requireAuthAccessRoutes(apiRequest, [1], definition, [1])
      expect(consoleAuthPageResponse(apiRequest, apiDenied, "/portal/")).toBe(apiDenied)
      expect(apiDenied?.status).toBe(403)

      // Every stateless Console call carries the session cookie and is authorized on its own.
      const rpcCall = (headers: Record<string, string>) => new Request("https://example.com/portal/_vitehub/rpc/__call", {
        body: JSON.stringify({ method: "vitehub:console:sections" }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      })
      expect((await requireAuthAccessRoutes(rpcCall({ cookie }), [0], definition, [0]))?.status).toBe(403)
      expect((await requireAuthAccessRoutes(rpcCall({}), [0], definition, [0]))?.status).toBe(401)

      const signOut = await handleAuthRequest(definition, new Request("https://example.com/portal/api/_vitehub/console/auth/sign-out", {
        body: "{}",
        headers: { "content-type": "application/json", cookie, origin: "https://example.com" },
        method: "POST",
      }))
      expect(signOut.status).toBe(200)
      expect(signOut.headers.getSetCookie().join("; ")).toContain("vitehub_console.session_token=")
    }
    finally {
      database.close()
    }
  })

  it("generates a guarded Console route without app Auth discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-handlers-"))
    try {
      const directory = resolve(root, "vitehub/console/auth")
      await mkdir(directory, { recursive: true })
      const server = resolve(directory, "server.ts")
      await writeFile(server, "export default {}")
      const handlers = await writeConsoleAuthHandlers(root, { server })
      const middleware = await readFile(handlers.middleware, "utf8")
      const route = await readFile(handlers.route, "utf8")
      expect(middleware).toContain("redirectToSignIn: path === '/_vitehub' && event.url.searchParams.has('auth_start')")
      expect(middleware).toContain('from "#vitehub/auth/server"')
      expect(middleware).toContain('requireAuthAccessRoutes(event, [1], definition, [1], { redirectToSignIn: false })')
      expect(middleware).toContain("await prepare(event)")
      expect(middleware).toContain("'/api/_vitehub/console/auth/'")
      expect(middleware).toContain("path === '/_vitehub/sign-in'")
      expect(await readFile(handlers.signIn, "utf8")).toContain("consoleAuthSignInPage(signInProvider, event.req")
      expect(route).toContain("handleAuthRequest(definition, event.req")
      expect(route).toContain('from "#vitehub/auth/server"')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("generates session auth routes from the final Vite base", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-final-base-"))
    try {
      const server = resolve(root, "console-auth.ts")
      await writeFile(server, "export default {}")
      await resolveConfig({
        root,
        configFile: false,
        base: "/early/",
        plugins: [
          consoleVitePlugin({ console: { access: "auth", auth: { server } }, preset: "node" }),
          { name: "change-console-base", config: () => ({ base: "/portal/" }) },
        ],
      }, "build", "production")
      const middleware = await readFile(resolve(root, ".vitehub/nitro/console/auth-middleware.mjs"), "utf8")
      expect(middleware).toContain('const mountBase = "/portal"')
      expect(middleware).not.toContain("/early/")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("bundles a discovered Console client extension", async () => {
    const root = await mkdtemp(join(process.cwd(), ".vitehub-console-auth-client-"))
    try {
      const directory = resolve(root, "vitehub/console/auth")
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, "server.ts"), "export default {}")
      const clientSource = resolve(directory, "client.ts")
      await writeFile(clientSource, 'export default { plugins: [], setup() { globalThis.consoleAuthMarker = "original" } }')
      const files = resolveConsoleAuthConfig(root, {})
      if ("provider" in files) throw new TypeError("Expected file configuration.")
      const handlers = await writeConsoleAuthHandlers(root, files)
      const responseSource = await readFile(handlers.client, "utf8")
      expect(handlers.clientSource).toBe(clientSource)
      expect(responseSource).toContain("vitehub.console.auth.client")
      expect(responseSource).toContain("text/javascript")
      expect(responseSource).toContain("original")
      await writeFile(clientSource, 'export default { plugins: [], setup() { globalThis.consoleAuthMarker = "updated" } }')
      await writeConsoleAuthHandlers(root, files)
      expect(await readFile(handlers.client, "utf8")).toContain("updated")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refreshes the Vite client handler when an imported local module changes", async () => {
    const root = await mkdtemp(join(process.cwd(), ".vitehub-console-auth-watch-"))
    try {
      const server = resolve(root, "server.ts")
      const client = resolve(root, "client.ts")
      const helper = resolve(root, "helper.ts")
      await writeFile(server, "export default {}")
      await writeFile(helper, 'export const marker = "vite_auth_helper_original"')
      await writeFile(client, 'import { marker } from "./helper"; export default { setup() { globalThis.consoleAuthMarker = marker } }')
      const plugin = consoleVitePlugin({ console: { access: "auth", auth: { server, client } }, preset: "node" })
      const listeners = new Map<string, (path: string) => Promise<void>>()
      const add = vi.fn()
      const config = { root }
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected Console config hook.")
      await Reflect.apply("handler" in configHook ? configHook.handler : configHook, {}, [config, { command: "serve", mode: "development" }])
      const configureServer = plugin.configureServer
      if (!configureServer) throw new TypeError("Expected Console development-server hook.")
      Reflect.apply("handler" in configureServer ? configureServer.handler : configureServer, {}, [{ config: { logger: { error: vi.fn() } }, watcher: { add, on: (event: string, listener: (path: string) => Promise<void>) => listeners.set(event, listener) } }])
      expect(add).toHaveBeenCalledWith(expect.arrayContaining([client, helper]))
      await writeFile(helper, 'export const marker = "vite_auth_helper_updated"')

      let markRefreshBuilt: (() => void) | undefined
      const refreshBuilt = new Promise<void>((resolve) => { markRefreshBuilt = resolve })
      let releaseRefresh: (() => void) | undefined
      const refreshPending = new Promise<void>((resolve) => { releaseRefresh = resolve })
      const writeHandlers = writeConsoleAuthHandlers
      const refresh = vi.spyOn(await import("../src/console/auth-build.ts"), "writeConsoleAuthHandlers").mockImplementationOnce(async (...args) => {
        const handlers = await writeHandlers(...args)
        markRefreshBuilt?.()
        await refreshPending
        return handlers
      })
      const first = listeners.get("change")?.(helper)
      let second: Promise<void> | undefined
      try {
        await refreshBuilt
        expect(await readFile(resolve(root, ".vitehub/nitro/console/auth-client.mjs"), "utf8")).toContain("vite_auth_helper_updated")
        await writeFile(helper, 'export const marker = "vite_auth_helper_concurrent"')
        second = listeners.get("add")?.(helper)
        expect(refresh).toHaveBeenCalledTimes(1)
        releaseRefresh?.()
        await Promise.all([first, second])
        expect(refresh).toHaveBeenCalledTimes(2)
        expect(await readFile(resolve(root, ".vitehub/nitro/console/auth-client.mjs"), "utf8")).toContain("vite_auth_helper_concurrent")
      }
      finally {
        releaseRefresh?.()
        await Promise.allSettled([first, second])
        refresh.mockRestore()
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("runs the generated guard only for Console requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-guard-"))
    try {
      const server = resolve(root, "server.ts")
      await writeFile(server, 'export default { signIn: { provider: "github" } }')
      const handlers = await writeConsoleAuthHandlers(root, { server })
      const bundled = await build({
        bundle: true,
        entryPoints: [handlers.middleware],
        format: "esm",
        platform: "node",
        write: false,
        plugins: [{
          name: "test-console-auth",
          setup(plugin) {
            plugin.onResolve({ filter: /^file:\/\// }, args => ({ path: fileURLToPath(args.path) }))
            plugin.onResolve({ filter: /^(#vitehub\/auth\/server|vite-hub\/console\/auth)$/ }, args => ({ path: args.path, namespace: "test-console-auth" }))
            plugin.onLoad({ filter: /.*/, namespace: "test-console-auth" }, (args) => ({
              contents: args.path === "#vitehub/auth/server"
                ? 'export function requireAuthAccessRoutes(event, indexes, definition, routes, options) { globalThis[Symbol.for("test.console.auth.calls")].push([event.url.pathname, indexes[0], options?.redirectToSignIn]); return new Response("guarded", {status: 401}) }'
                : "export function createConsoleAuthDefinition() { return {} }; export function prepareConsoleAuth() {}; export function consoleAuthPageResponse(_request, response) { return response }",
              loader: "js",
            }))
          },
        }],
      })
      const modulePath = resolve(root, "guard.mjs")
      await writeFile(modulePath, bundled.outputFiles![0]!.text)
      const guard = (await import(pathToFileURL(modulePath).href)) as { default: (event: { url: URL; req?: Request }) => Promise<Response | undefined> }
      const calls: Array<[string, number, boolean | undefined]> = []
      Reflect.set(globalThis, Symbol.for("test.console.auth.calls"), calls)
      try {
        expect(await guard.default({ url: new URL("https://example.com/api/app") })).toBeUndefined()
        expect(await guard.default({ url: new URL("https://example.com/api/_vitehub/console/auth/callback/github") })).toBeUndefined()
        expect(await guard.default({ url: new URL("https://example.com/_vitehub/sign-in") })).toBeUndefined()
        expect((await guard.default({ url: new URL("https://example.com/_vitehub") }))?.status).toBe(401)
        const apiURL = "https://example.com/api/_vitehub/console/status"
        expect((await guard.default({ url: new URL(apiURL), req: new Request(apiURL, { headers: { accept: "text/html" } }) }))?.status).toBe(401)
        const rpcURL = "https://example.com/_vitehub/rpc/__call"
        const rpcRequest = new Request(rpcURL, { body: "{}", headers: { "content-type": "application/json" }, method: "POST" })
        expect((await guard.default({ url: new URL(rpcURL), req: rpcRequest }))?.status).toBe(401)
        expect(calls).toEqual([
          ["/_vitehub", 0, false],
          ["/api/_vitehub/console/status", 1, false],
          ["/_vitehub/rpc/__call", 0, false],
        ])
      }
      finally {
        Reflect.deleteProperty(globalThis, Symbol.for("test.console.auth.calls"))
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("registers independent auth handlers in a production Vite host without Primary Auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-vite-"))
    try {
      const plugin = consoleVitePlugin({
        console: {
          access: "auth",
          auth: {
            provider: "github",
            allowedEmails: ["maintainer@example.com"],
            databasePath: "/data/console-auth.sqlite",
          },
        },
        preset: "node",
      })
      const hook = plugin.config
      if (!hook) throw new TypeError("Expected Console config hook.")
      const handler = "handler" in hook ? hook.handler : hook
      const config: { root: string, nitro?: { handlers: Array<{ route: string; middleware?: boolean }> } } = { root }
      await Reflect.apply(handler, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "/api/_vitehub/console/auth/**" }),
        expect.objectContaining({ route: "/_vitehub/sign-in" }),
        expect.objectContaining({ route: "/**", middleware: true }),
      ]))
      expect(await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"], true)`)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("serves a mounted sign-in page for custom providers and denied accounts", async () => {
    const response = consoleAuthSignInPage("google", new Request("https://example.com/portal/_vitehub/sign-in"), "/portal/")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain('href="/portal/_vitehub?auth_start=1"')
    expect(await consoleAuthSignInPage("google", new Request("https://example.com/portal/_vitehub/sign-in"), "/portal/").text()).toContain("Sign in with google")
    const denied = consoleAuthSignInPage("github", new Request("https://example.com/portal/_vitehub/sign-in?denied=1"), "/portal/")
    expect(await denied.text()).toContain("Choose a different account with your sign-in provider")
  })

  it("admits only active GitHub organization members with a verified email", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-org-"))
    vi.stubEnv("GITHUB_CLIENT_ID", "client-id")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "client-secret")
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-32-bytes-long")
    const github: Record<string, unknown> = {
      "/user": { id: 1, login: "octocat", name: null, avatar_url: "https://avatars.example/octocat" },
      "/user/memberships/orgs/acme": { state: "active" },
      "/user/emails?per_page=100&page=1": [
        { email: "secondary@example.com", verified: true },
        { email: "primary@example.com", primary: true, verified: true },
      ],
    }
    const requests: string[] = []
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      requests.push(`${url.pathname}${url.search} ${new Headers(init?.headers).get("authorization")}`)
      const path = `${url.pathname}${url.search}`
      return path in github ? Response.json(github[path]) : new Response("{}", { status: 404 })
    })
    try {
      const databasePath = join(root, "nested", "console-auth.sqlite")
      const input = createInlineConsoleAuth({ provider: "github", org: ["other", "acme"], databasePath, session: { expiresIn: 43_200 } })
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600)
      expect(input.signIn.scopes).toEqual(["read:org", "user:email"])
      const options = input.auth.options
      if (typeof options !== "function") throw new TypeError("Expected resolved Console Auth options.")
      const resolved = options({ env: {}, requestOrigin: "https://example.com" })
      expect(resolved.session).toEqual({ expiresIn: 43_200 })
      const githubOptions = resolved.socialProviders?.github
      const getUserInfo = githubOptions && typeof githubOptions !== "function" ? githubOptions.getUserInfo : undefined
      if (!getUserInfo) throw new TypeError("Expected a GitHub organization check.")

      expect(await getUserInfo({ accessToken: "token" })).toEqual({
        data: github["/user"],
        user: { email: "primary@example.com", emailVerified: true, image: "https://avatars.example/octocat", name: "octocat" },
      })
      expect(requests).toContain("/user/memberships/orgs/acme Bearer token")
      github["/user/emails?per_page=100&page=1"] = [{ email: "primary@example.com", primary: true, verified: false }, { email: "other@example.com", verified: true }]
      expect((await getUserInfo({ accessToken: "token" }))?.user.email).toBe("other@example.com")
      github["/user/emails?per_page=100&page=1"] = Array.from({ length: 100 }, () => ({ email: "secondary@example.com", verified: true }))
      github["/user/emails?per_page=100&page=2"] = [{ email: "primary@example.com", primary: true, verified: true }]
      expect((await getUserInfo({ accessToken: "token" }))?.user.email).toBe("primary@example.com")
      github["/user/emails?per_page=100&page=2"] = []
      expect((await getUserInfo({ accessToken: "token" }))?.user.email).toBe("secondary@example.com")
      delete github["/user/emails?per_page=100&page=2"]
      expect(await getUserInfo({ accessToken: "token" })).toBeNull()
      github["/user/emails?per_page=100&page=1"] = [{ email: "primary@example.com", primary: true, verified: false }]
      expect(await getUserInfo({ accessToken: "token" })).toBeNull()
      github["/user/emails?per_page=100&page=1"] = [{ email: "primary@example.com", primary: true, verified: true }]
      github["/user/memberships/orgs/acme"] = { state: "pending" }
      expect(await getUserInfo({ accessToken: "token" })).toBeNull()
      expect(await getUserInfo({})).toBeNull()

      expect(await input.authorize({ user: { email: "primary@example.com", emailVerified: true } } as never)).toBe(true)
      expect(await input.authorize({ user: { email: "primary@example.com", emailVerified: false } } as never)).toBe(false)

      const both = createInlineConsoleAuth({ provider: "github", org: "acme", allowedEmails: ["Primary@example.com"], databasePath })
      expect(await both.authorize({ user: { email: "primary@example.com", emailVerified: true } } as never)).toBe(true)
      expect(await both.authorize({ user: { email: "other@example.com", emailVerified: true } } as never)).toBe(false)

      const emailsOnly = createInlineConsoleAuth({ provider: "github", allowedEmails: ["primary@example.com"], databasePath })
      const emailsOnlyOptions = emailsOnly.auth.options
      if (typeof emailsOnlyOptions !== "function") throw new TypeError("Expected resolved Console Auth options.")
      expect(emailsOnly.signIn.scopes).toEqual(["user:email"])
      expect(emailsOnlyOptions({ env: {}, requestOrigin: "https://example.com" }).socialProviders?.github).not.toHaveProperty("getUserInfo")

      expect(() => createInlineConsoleAuth({ provider: "github", org: [], allowedEmails: ["primary@example.com"], databasePath })).toThrow("GitHub organization login")
      expect(() => resolveConsoleAuthConfig(root, { provider: "github", org: [], allowedEmails: ["primary@example.com"], databasePath })).toThrow("GitHub organization login")
      for (const org of ["../admin", "-acme", "acme-", "acme--team", "a".repeat(40)]) {
        expect(() => createInlineConsoleAuth({ provider: "github", org, databasePath })).toThrow("GitHub organization login")
        expect(() => resolveConsoleAuthConfig(root, { provider: "github", org, databasePath })).toThrow("GitHub organization login")
      }
      for (const org of ["a", "Acme-Team", "a".repeat(39)]) {
        expect(() => resolveConsoleAuthConfig(root, { provider: "github", org, databasePath })).not.toThrow()
      }
      expect(() => createInlineConsoleAuth({ provider: "github", databasePath })).toThrow("allowedEmails, org, or both")
      expect(() => resolveConsoleAuthConfig(root, { provider: "github", org: "acme" })).toThrow("Set databasePath or dataDir")
    }
    finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("selects an allowlisted verified email for organization members across pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-combined-"))
    vi.stubEnv("GITHUB_CLIENT_ID", "client-id")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "client-secret")
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-32-bytes-long")
    const emailsPath = "/user/emails?per_page=100&page="
    const github: Record<string, unknown> = {
      "/user": { id: 1, login: "octocat" },
      "/user/memberships/orgs/acme": { state: "active" },
    }
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input)
      const path = `${url.pathname}${url.search}`
      return path in github ? Response.json(github[path]) : new Response("{}", { status: 404 })
    })
    let database: DatabaseSync | undefined
    try {
      const input = createInlineConsoleAuth({
        provider: "github", org: "acme", allowedEmails: ["Secondary@example.com", "allowed@example.com"],
        databasePath: join(root, "console-auth.sqlite"),
      })
      const options = input.auth.options
      if (typeof options !== "function") throw new TypeError("Expected resolved Console Auth options.")
      const resolved = options({ env: {}, requestOrigin: "https://example.com" })
      if (!(resolved.database instanceof DatabaseSync)) throw new TypeError("Expected a SQLite database.")
      database = resolved.database
      const provider = resolved.socialProviders?.github
      const getUserInfo = provider && typeof provider !== "function" ? provider.getUserInfo : undefined
      if (!getUserInfo) throw new TypeError("Expected a GitHub organization check.")
      const primary = { email: "primary@example.com", primary: true, verified: true }
      const secondary = { email: "SECONDARY@example.com", verified: true }
      github[`${emailsPath}1`] = [primary, secondary]
      const admitted = await getUserInfo({ accessToken: "token" })
      expect(admitted?.user.email).toBe(secondary.email)
      expect(await input.authorize({ user: admitted?.user } as never)).toBe(true)

      // An unallowlisted primary must not stop lookup before a later allowed email.
      github[`${emailsPath}1`] = Array.from({ length: 100 }, () => primary)
      github[`${emailsPath}2`] = [secondary]
      expect((await getUserInfo({ accessToken: "token" }))?.user.email).toBe(secondary.email)

      github[`${emailsPath}1`] = Array.from({ length: 100 }, () => secondary)
      github[`${emailsPath}2`] = [{ email: "allowed@example.com", primary: true, verified: true }]
      expect((await getUserInfo({ accessToken: "token" }))?.user.email).toBe("allowed@example.com")
      delete github[`${emailsPath}2`]
      expect(await getUserInfo({ accessToken: "token" })).toBeNull()
      github[`${emailsPath}1`] = [primary, { ...secondary, verified: false }]
      expect(await getUserInfo({ accessToken: "token" })).toBeNull()
      github[`${emailsPath}1`] = [secondary]
      github["/user/memberships/orgs/acme"] = { state: "pending" }
      expect(await getUserInfo({ accessToken: "token" })).toBeNull()
    }
    finally {
      database?.close()
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("requires new session cookies when the organization gate changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-policy-"))
    vi.stubEnv("GITHUB_CLIENT_ID", "client-id")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "client-secret")
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-32-bytes-long")
    const databases: DatabaseSync[] = []
    try {
      const databasePath = join(root, "console-auth.sqlite")
      const withGate = (org?: string | string[]) => {
        const input = createInlineConsoleAuth({ provider: "github", allowedEmails: ["user@example.com"], org, databasePath })
        const options = input.auth.options
        if (typeof options !== "function") throw new TypeError("Expected resolved Console Auth options.")
        const resolved = options({ env: {}, requestOrigin: "https://example.com" })
        if (!(resolved.database instanceof DatabaseSync)) throw new TypeError("Expected a SQLite database.")
        databases.push(resolved.database)
        // Use a local sign-in to issue real Better Auth cookies without a live GitHub OAuth exchange.
        return { ...input, auth: defineAuth(() => ({ ...resolved, emailAndPassword: { enabled: true } })) }
      }
      const emailOnly = withGate()
      const definition = createConsoleAuthDefinition(emailOnly)
      const signUp = new Request("https://example.com/api/_vitehub/console/auth/sign-up/email", {
        body: JSON.stringify({ email: "user@example.com", name: "User", password: "passwordpassword" }),
        headers: { "content-type": "application/json", origin: "https://example.com" },
        method: "POST",
      })
      await prepareConsoleAuth(emailOnly, definition, signUp)
      const response = await handleAuthRequest(definition, signUp)
      expect(response.status).toBe(200)
      const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      databases[0]!.exec('UPDATE "user" SET "emailVerified" = 1')
      const protectedRequest = (sessionCookie: string) => new Request("https://example.com/api/_vitehub/console/status", {
        headers: { cookie: sessionCookie },
      })
      expect(await requireAuthAccessRoutes(protectedRequest(cookie), [1], definition, [1])).toBeUndefined()
      const orgInput = withGate(["acme", "other"])
      const orgDefinition = createConsoleAuthDefinition(orgInput)
      expect((await requireAuthAccessRoutes(protectedRequest(cookie), [1], orgDefinition, [1]))?.status).toBe(401)
      const signIn = await handleAuthRequest(orgDefinition, new Request("https://example.com/api/_vitehub/console/auth/sign-in/email", {
        body: JSON.stringify({ email: "user@example.com", password: "passwordpassword" }),
        headers: { "content-type": "application/json", origin: "https://example.com" },
        method: "POST",
      }))
      expect(signIn.status).toBe(200)
      const orgCookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      expect(await requireAuthAccessRoutes(protectedRequest(orgCookie), [1], orgDefinition, [1])).toBeUndefined()
      const equivalent = createConsoleAuthDefinition(withGate(["OTHER", "acme", "acme"]))
      expect(await requireAuthAccessRoutes(protectedRequest(orgCookie), [1], equivalent, [1])).toBeUndefined()
      const changed = createConsoleAuthDefinition(withGate("different"))
      expect((await requireAuthAccessRoutes(protectedRequest(orgCookie), [1], changed, [1]))?.status).toBe(401)
    }
    finally {
      for (const database of databases) database.close()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects inline SQLite auth on Cloudflare while allowing file-based auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-preset-"))
    try {
      expect(() => resolveConsoleAuthConfig(root, {
        provider: "github",
        allowedEmails: ["maintainer@example.com"],
        databasePath: "/data/console-auth.sqlite",
      }, "cloudflare")).toThrow("requires the Node deployment preset")

      const plugin = consoleVitePlugin({
        console: {
          access: "auth",
          auth: {
            provider: "github",
            allowedEmails: ["maintainer@example.com"],
            databasePath: "/data/console-auth.sqlite",
          },
        },
        preset: "cloudflare",
      })
      const hook = plugin.config
      if (!hook) throw new TypeError("Expected Console config hook.")
      const handler = "handler" in hook ? hook.handler : hook
      await expect(Reflect.apply(handler, {}, [{ root }, { command: "build", mode: "production" }]))
        .rejects.toThrow("requires the Node deployment preset")

      const server = resolve(root, "server.ts")
      await writeFile(server, "export default {}")
      expect(resolveConsoleAuthConfig(root, { server }, "cloudflare")).toEqual({ server })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
