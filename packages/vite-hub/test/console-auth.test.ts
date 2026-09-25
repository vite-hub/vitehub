import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

import { defineAuth } from "@vite-hub/auth"
import { requireAuthAccessRoutes } from "@vite-hub/auth/server"
import { describe, expect, it } from "vitest"
import { build } from "esbuild"

import { createConsoleAuthDefinition, defineConsoleAuth, prepareConsoleAuth } from "../src/console/auth.ts"
import { resolveConsoleAuthConfig, writeConsoleAuthHandlers } from "../src/console/auth-build.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import signedOutHandler from "../src/console/runtime/server/signed-out.get.ts"
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

  it("rejects unauthenticated Console requests and redirects a browser to GitHub sign-in", async () => {
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
      const pageResponse = await requireAuthAccessRoutes(pageRequest, [0], definition, [0])
      expect(pageResponse?.status).toBe(302)
      expect(pageResponse?.headers.get("location")).toContain("github.com")
      expect(pageResponse?.headers.get("location")).toContain("api%2F_vitehub%2Fconsole%2Fauth%2Fcallback%2Fgithub")
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
      expect(middleware).toContain('requireAuthAccessRoutes(event, [0], definition, [0])')
      expect(middleware).toContain('from "#vitehub/auth/server"')
      expect(middleware).toContain('requireAuthAccessRoutes(event, [1], definition, [1])')
      expect(middleware).toContain("await prepare(event)")
      expect(middleware).toContain("'/api/_vitehub/console/auth/'")
      expect(middleware).toContain("path === '/_vitehub/signed-out'")
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
      await writeFile(resolve(directory, "client.ts"), "export default { plugins: [], setup() {} }")
      const files = resolveConsoleAuthConfig(root, {})
      if ("provider" in files) throw new TypeError("Expected file configuration.")
      const handlers = await writeConsoleAuthHandlers(root, files)
      const responseSource = await readFile(handlers.client, "utf8")
      expect(responseSource).toContain("vitehub.console.auth.client")
      expect(responseSource).toContain("text/javascript")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("runs the generated guard only for Console requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-guard-"))
    try {
      const server = resolve(root, "server.ts")
      await writeFile(server, "export default {}")
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
                ? 'export function requireAuthAccessRoutes(event, indexes) { globalThis[Symbol.for("test.console.auth.calls")].push([event.url.pathname, indexes[0]]); return new Response("guarded", {status: 401}) }'
                : "export function createConsoleAuthDefinition() { return {} }; export function prepareConsoleAuth() {}",
              loader: "js",
            }))
          },
        }],
      })
      const modulePath = resolve(root, "guard.mjs")
      await writeFile(modulePath, bundled.outputFiles![0]!.text)
      const guard = (await import(pathToFileURL(modulePath).href)) as { default: (event: { url: URL }) => Promise<Response | undefined> }
      const calls: Array<[string, number]> = []
      Reflect.set(globalThis, Symbol.for("test.console.auth.calls"), calls)
      try {
        expect(await guard.default({ url: new URL("https://example.com/api/app") })).toBeUndefined()
        expect(await guard.default({ url: new URL("https://example.com/api/_vitehub/console/auth/callback/github") })).toBeUndefined()
        expect(await guard.default({ url: new URL("https://example.com/_vitehub/signed-out") })).toBeUndefined()
        expect((await guard.default({ url: new URL("https://example.com/_vitehub") }))?.status).toBe(401)
        expect((await guard.default({ url: new URL("https://example.com/api/_vitehub/console/status") }))?.status).toBe(401)
        expect(calls).toEqual([
          ["/_vitehub", 0],
          ["/api/_vitehub/console/status", 1],
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
        expect.objectContaining({ route: "/_vitehub/signed-out" }),
        expect.objectContaining({ route: "/**", middleware: true }),
      ]))
      expect(await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"], true)`)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("serves a signed-out page with a mounted Console sign-in link", async () => {
    const response = signedOutHandler({ req: { url: "https://example.com/portal/_vitehub/signed-out" } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain('href="/portal/_vitehub"')
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
