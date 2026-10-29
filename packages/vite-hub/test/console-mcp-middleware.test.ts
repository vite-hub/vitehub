import { build } from "esbuild"
import { defineHandler } from "h3"
import { createApp, eventHandler, toNodeListener } from "h3-v1"
import { createServer } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { defineAuth } from "@vite-hub/auth"
import type { AuthAccessAuthorizationContext } from "@vite-hub/auth"
import { createAuthAccessHandler, createAuthForRequest, setAuthAccessIdentityResolver } from "@vite-hub/auth/server"
import { afterEach, expect, it, onTestFinished } from "vitest"

import { consoleOAuthPlugins } from "../src/console/auth-oauth.ts"
import { defineConsoleAuth } from "../src/console/auth.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { writeConsoleAuthHandlers } from "../src/console/auth-build.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleOAuthConfig } from "../src/console/runtime/server/bearer.ts"
import consoleMcpHandler from "../src/console/runtime/server/mcp.ts"
import consoleMcpDiscoveryHandler from "../src/console/runtime/server/mcp-discovery.ts"

const require = createRequire(import.meta.url)
const fixtureKey = Symbol.for("test.console.mcp.middleware")
const sectionPolicyKey = Symbol.for("test.console.mcp.section-policy")

afterEach(() => {
  Reflect.deleteProperty(globalThis, fixtureKey)
  Reflect.deleteProperty(globalThis, sectionPolicyKey)
  installConsoleAccess({ mode: "open" })
})

it.each(["", "/portal"])("runs generated middleware before MCP at mount '%s' with both host event formats", async (mount) => {
  const root = await mkdtemp(resolve(import.meta.dirname, ".mcp-middleware-"))
  const database = new DatabaseSync(":memory:")
  const origin = "https://app.example.com"
  const path = `${mount}/_vitehub/mcp`
  const resource = `${origin}${path}`
  let allowed = true
  const input = defineConsoleAuth({
    auth: defineAuth(() => ({ database, secret: "test-secret-at-least-32-bytes-long", socialProviders: { github: { clientId: "id", clientSecret: "secret" } } })),
    authorize: ({ user, session }) => allowed && user.email === "ada@example.com" && Object.keys(session).length === 0,
    signIn: { provider: "github" },
  })
  Reflect.set(globalThis, fixtureKey, input)
  try {
    const serverFile = resolve(root, "server.mjs")
    await writeFile(serverFile, 'export default globalThis[Symbol.for("test.console.mcp.middleware")]')
    const handlers = await writeConsoleAuthHandlers(root, { server: serverFile }, `${mount}/`)
    const modulePath = resolve(root, "middleware.mjs")
    await build({
      bundle: true,
      entryPoints: [handlers.middleware],
      format: "esm",
      outfile: modulePath,
      packages: "external",
      platform: "node",
      plugins: [{
        name: "generated-console-auth-imports",
        setup(plugin) {
          plugin.onResolve({ filter: /^file:\/\// }, args => ({ path: fileURLToPath(args.path) }))
          plugin.onResolve({ filter: /^#vitehub\/auth\/server$/ }, () => ({ path: require.resolve("@vite-hub/auth/server"), external: true }))
          plugin.onResolve({ filter: /^vite-hub\/console\/auth$/ }, () => ({ path: resolve(import.meta.dirname, "../src/console/auth.ts") }))
        },
      }],
    })
    // SAFETY: These exports come from writeConsoleAuthHandlers above; the requests below exercise their contract.
    const guard = await import(pathToFileURL(modulePath).href) as {
      default: (event: object) => Promise<Response | undefined>
      authorizeConsoleBearer: NonNullable<ConsoleOAuthConfig["authorize"]>
      checkConsoleAccess: (event: object) => Promise<Response | undefined>
      createConsoleAuth: ConsoleOAuthConfig["auth"]
    }
    // Delegation still prepares the real SQLite-backed Auth before the route checks a token.
    await guard.default({ req: new Request(resource) })
    const instance = guard.createConsoleAuth(new Request(resource), { req: new Request(resource) })
    const context = await instance.$context
    // SAFETY: Better Auth's adapter and JWT plugin add these runtime methods.
    const adapter = context.internalAdapter as typeof context.internalAdapter & { createUser: (user: object) => Promise<{ id: string }> }
    const signer = instance.api as typeof instance.api & { signJWT: (input: object) => Promise<{ token: string }> }
    const user = await adapter.createUser({ email: "ada@example.com", emailVerified: true, name: "Ada" })
    const { token } = await signer.signJWT({ body: { overrideOptions: { jwt: { expirationTime: "5m" } }, payload: { aud: resource, iss: context.baseURL, scope: "vitehub:read", sub: user.id } } })
    let sectionAllowed = true
    installConsoleAccess({
      authorize: () => sectionAllowed,
      check: guard.checkConsoleAccess,
      mode: "auth",
      oauth: { auth: guard.createConsoleAuth, authorize: guard.authorizeConsoleBearer, path, resource },
    })
    const handler = async (event: object) => await guard.default(event) ?? Reflect.apply(consoleMcpHandler, undefined, [event])
    const app = createApp()
    app.use(mount || "/", eventHandler(handler))
    const server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing test server address")
      const transports = [
        (request: Request) => defineHandler(handler).fetch(request),
        (request: Request) => fetch(new Request(`http://127.0.0.1:${address.port}${new URL(request.url).pathname}`, request)),
      ]
      for (const send of transports) {
        const request = (token?: string, pathname = path) => new Request(`${origin}${pathname}`, {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          method: "POST",
        })
        const anonymous = await send(request())
        expect(anonymous.status).toBe(401)
        expect(anonymous.headers.get("www-authenticate")).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"`)
        const accepted = await send(request(token))
        expect(accepted.status).toBe(200)
        await expect(accepted.json()).resolves.toMatchObject({ result: { tools: expect.any(Array) } })
        allowed = false
        expect((await send(request(token))).status).toBe(403)
        allowed = true
        sectionAllowed = false
        expect((await send(request(token))).status).toBe(403)
        sectionAllowed = true
        expect((await send(request("invalid"))).status).toBe(401)
        for (const sibling of [`${mount}/_vitehub/rpc/__call`, `${path}/extra`]) {
          expect((await send(request(token, sibling))).status).toBe(401)
        }
      }
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
  finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ["", true], ["/portal", true], ["", false], ["/portal", false],
] as const)("checks MCP token identities at '%s' with matching app Auth routes: %s", async (mount, matchesMcp) => {
  const root = await mkdtemp(resolve(import.meta.dirname, ".mcp-app-middleware-"))
  const database = new DatabaseSync(":memory:")
  const origin = "https://app.example.com"
  const path = `${mount}/_vitehub/mcp`
  const resource = `${origin}${path}`
  onTestFinished(async () => {
    setAuthAccessIdentityResolver(path, undefined)
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  let allowed = true
  let sectionAllowed = true
  const seen: object[] = []
  const route = matchesMcp ? "/**" : "/private/**"
  const definition = defineAuth(() => ({
    baseURL: origin,
    database,
    secret: "test-secret-at-least-32-bytes-long",
    plugins: consoleOAuthPlugins({ mountBaseURL: `${mount}/`, origin, plugins: [] }),
    access: { routes: [{ route, authorize: (context: AuthAccessAuthorizationContext) => {
      seen.push(context)
      return allowed && context.user.email === "ada@example.com" && Object.keys(context.session).length === 0
    } }] },
  }))
  const routes = [{ route, authorize: true as const }]
  const middleware = createAuthAccessHandler(routes, definition)
  const instance = createAuthForRequest(definition, new Request(resource))
  const context = await instance.$context
  await context.runMigrations()
  // SAFETY: Better Auth's adapter and JWT plugin provide these runtime methods.
  const adapter = context.internalAdapter as typeof context.internalAdapter & { createUser: (user: object) => Promise<{ id: string }> }
  const signer = instance.api as typeof instance.api & { signJWT: (input: object) => Promise<{ token: string }> }
  const user = await adapter.createUser({ email: "ada@example.com", emailVerified: true, name: "Ada" })
  const { token } = await signer.signJWT({ body: { overrideOptions: { jwt: { expirationTime: "5m" } }, payload: { aud: resource, iss: context.baseURL, scope: "vitehub:read", sub: user.id } } })
  Reflect.set(globalThis, fixtureKey, definition)
  Reflect.set(globalThis, sectionPolicyKey, () => sectionAllowed)
  const authorizeFile = resolve(root, "authorize.mjs")
  await writeFile(authorizeFile, 'export default globalThis[Symbol.for("test.console.mcp.section-policy")]')
  const generated = resolve(root, "plugin.ts")
  const modulePath = resolve(root, "plugin.mjs")
  await writeConsoleNitroPlugin(generated, root, [], [], { agents: [], content: {} }, [], undefined, undefined, false, undefined, () => true, undefined, false, undefined, {
    authorize: authorizeFile,
    check: { appRoutes: routes.map((route, index) => ({ ...route, index })) },
    mode: "auth",
    oauth: { path, resource },
  })
  await build({
    bundle: true, entryPoints: [generated], format: "esm", outfile: modulePath, packages: "external", platform: "node",
    plugins: [{
      name: "app-auth-generated-plugin",
      setup(plugin) {
        plugin.onResolve({ filter: /^file:\/\// }, args => ({ path: fileURLToPath(args.path) }))
        plugin.onResolve({ filter: /^#vitehub\/auth\/server$/ }, () => ({ path: "app-auth", namespace: "fixture" }))
        plugin.onResolve({ filter: /^@vite-hub\/auth\/server$/ }, () => ({ path: require.resolve("@vite-hub/auth/server"), external: true }))
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
          import * as auth from "@vite-hub/auth/server";
          const definition = globalThis[Symbol.for("test.console.mcp.middleware")];
          export const getAuthForRequest = (request, _, event) => auth.createAuthForRequest(definition, request, undefined, event);
          export const requireAuthAccessRoutes = (event, indexes, _, required, options) => auth.requireAuthAccessRoutes(event, indexes, definition, required, options);
          export const withAuthorization = (authorize, handler) => auth.withAuthorization(authorize, handler, definition);
          export const setAuthAccessIdentityResolver = auth.setAuthAccessIdentityResolver;
        ` }))
        plugin.onResolve({ filter: /^vite-hub\/console\/sections$/ }, () => ({ path: resolve(import.meta.dirname, "../src/console/runtime/server/sections.ts") }))
        plugin.onResolve({ filter: /^vite-hub\/console\/auth$/ }, () => ({ path: resolve(import.meta.dirname, "../src/console/auth.ts") }))
      },
    }],
  })
  await import(pathToFileURL(modulePath).href)
  const config: { handlers: Array<{ handler: string; route: string; method?: string; middleware?: boolean }> } = {
    handlers: [{ handler: "app-auth", middleware: true, route: "/**" }],
  }
  addConsoleRpcHandler(config, "/runtime", `${mount}/`, [], true)
  const handler = async (event: object) => {
    // Nitro runs global middleware before routed middleware, regardless of their registration order.
    for (const registration of config.handlers.filter(candidate => candidate.middleware && candidate.route === "/**" && !candidate.method)) {
      const response = registration.handler === "app-auth"
        ? await middleware(event as never)
        : await Reflect.apply(consoleMcpDiscoveryHandler, undefined, [event])
      if (response) return response
    }
    return Reflect.apply(consoleMcpHandler, undefined, [event])
  }
  const app = createApp()
  app.use(eventHandler(handler))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test server address")
    for (const send of [
      (request: Request) => defineHandler(handler).fetch(request),
      (request: Request) => fetch(new Request(`http://127.0.0.1:${address.port}${new URL(request.url).pathname}`, request)),
    ]) {
      for (const pathname of [
        "/.well-known/oauth-protected-resource",
        `/.well-known/oauth-protected-resource${path}`,
        "/.well-known/oauth-authorization-server",
        `/.well-known/oauth-authorization-server${new URL(context.baseURL).pathname}`,
      ]) {
        const discovery = await send(new Request(`${origin}${pathname}`))
        expect(discovery.status, await discovery.clone().text()).toBe(200)
        await expect(discovery.json()).resolves.toMatchObject(pathname.includes("protected-resource") ? { resource } : { issuer: context.baseURL })
      }
      expect((await send(new Request(`${origin}/.well-known/private`))).status).toBe(401)
      expect((await send(new Request(`${origin}/.well-known/oauth-protected-resource`, { method: "POST" }))).status).toBe(401)
      const request = (value?: string, pathname = path) => new Request(`${origin}${pathname}`, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        headers: { "content-type": "application/json", ...(value ? { authorization: `Bearer ${value}` } : {}) },
        method: "POST",
      })
      expect((await send(request(token))).status).toBe(200)
      if (matchesMcp) expect(seen.at(-1)).toMatchObject({ user: { id: user.id }, session: {} })
      else expect(seen).toHaveLength(0)
      const anonymous = await send(request())
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get("www-authenticate")).toContain(`/.well-known/oauth-protected-resource${path}`)
      allowed = false
      expect((await send(request(token))).status).toBe(matchesMcp ? 403 : 200)
      allowed = true
      sectionAllowed = false
      expect((await send(request(token))).status).toBe(403)
      sectionAllowed = true
      const invalid = await send(request("invalid"))
      expect(invalid.status).toBe(401)
      expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"')
      for (const sibling of [`${mount}/_vitehub/rpc/__call`, `${path}/extra`]) {
        expect((await send(request(token, sibling))).status).toBe(401)
      }
    }
  }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
