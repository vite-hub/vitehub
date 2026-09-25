import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

import { defineAuth } from "@vite-hub/auth"
import { handleAuthRequest, requireAuthAccessRoutes } from "@vite-hub/auth/server"
import { describe, expect, it, vi } from "vitest"
import { build } from "esbuild"

import { consoleAuthPageResponse, consoleAuthSignInPage, createConsoleAuthDefinition, defineConsoleAuth, prepareConsoleAuth } from "../src/console/auth.ts"
import { resolveConsoleAuthConfig, writeConsoleAuthHandlers } from "../src/console/auth-build.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { installConsoleProjectNameScope, installConsoleSectionScope, resolveConsoleAuth } from "../src/console/internal.ts"

import type { ConsoleInvocationScope } from "../src/console/internal.ts"

describe("independent Console Auth", () => {
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
      await writeFile(helper, 'export const marker = "original"')
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
      await writeFile(helper, 'export const marker = "updated"')
      await listeners.get("change")?.(helper)
      expect(await readFile(resolve(root, ".vitehub/nitro/console/auth-client.mjs"), "utf8")).toContain("updated")
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
        expect(calls).toEqual([
          ["/_vitehub", 0, false],
          ["/api/_vitehub/console/status", 1, false],
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
