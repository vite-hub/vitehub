import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { env } from "@vite-hub/env"
import { build } from "esbuild"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { Miniflare } from "miniflare"
import { resolveConfig } from "vite"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { createCloudflareAccessVerifier, handleCloudflareAccessConsoleRequest, type CloudflareAccessVerifier } from "../src/console/auth-cloudflare-access.ts"
import { resolveConsoleAuthConfig, writeConsoleAuthHandlers } from "../src/console/auth-build.ts"
import { cloudflareAccessIssuer } from "../src/console/auth-path.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

const packageRoot = resolve(import.meta.dirname, "..")
const teamDomain = "acme.cloudflareaccess.com"
const issuer = `https://${teamDomain}`
const audience = "console-aud"

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwks: { keys: Array<Record<string, unknown>> }

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true })
  privateKey = pair.privateKey
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: "access-key", use: "sig" }] }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function accessToken(claims: { aud?: string, email?: string, common_name?: string, exp?: number, iss?: string } = {}): Promise<string> {
  const { aud = audience, exp, iss = issuer, ...payload } = claims
  return await new SignJWT({ email: "maintainer@example.com", ...payload })
    .setProtectedHeader({ alg: "RS256", kid: "access-key" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp ?? "5m")
    .sign(privateKey)
}

function certsFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== `${issuer}/cdn-cgi/access/certs`) return new Response("not found", { status: 404 })
    return Response.json(jwks)
  })
}

function consoleEvent(url: string, token?: string, method = "GET"): { req: Request, url: URL } {
  const headers = new Headers(token ? { "cf-access-jwt-assertion": token } : {})
  return { req: new Request(url, { headers, method }), url: new URL(url) }
}

async function bundleMiddleware(root: string, platform: "browser" | "node", middleware?: string): Promise<string> {
  middleware ??= (await writeConsoleAuthHandlers(root, resolveConsoleAuthConfig(root, { provider: "cloudflare-access" }, "cloudflare"))).middleware
  const bundled = await build({
    bundle: true,
    conditions: platform === "browser" ? ["workerd", "worker", "browser"] : [],
    entryPoints: [middleware],
    external: ["node:*"],
    format: "esm",
    platform,
    write: false,
    plugins: [{
      name: "test-cloudflare-access-imports",
      setup(plugin) {
        plugin.onResolve({ filter: /^vite-hub\/console\/auth\/cloudflare-access$/ }, () => ({ path: resolve(packageRoot, "src/console/auth-cloudflare-access.ts") }))
        plugin.onResolve({ filter: /^vite-hub\/env\/server$/ }, () => ({ path: resolve(packageRoot, "src/env/server.ts") }))
      },
    }],
  })
  const text = bundled.outputFiles?.[0]?.text
  if (!text) throw new TypeError("Expected a bundled Cloudflare Access middleware.")
  return text
}

describe("Cloudflare Access Console Auth", () => {
  it("normalizes team domains to an HTTPS issuer", () => {
    expect(cloudflareAccessIssuer("acme.cloudflareaccess.com")).toBe(issuer)
    expect(cloudflareAccessIssuer("https://acme.cloudflareaccess.com/")).toBe(issuer)
    expect(cloudflareAccessIssuer("http://acme.cloudflareaccess.com")).toBeUndefined()
    expect(cloudflareAccessIssuer("acme.cloudflareaccess.com/cdn-cgi")).toBeUndefined()
    expect(cloudflareAccessIssuer(" ")).toBeUndefined()
  })

  it("verifies Access tokens and caches the team key set", async () => {
    const fetch = certsFetch()
    const verify = createCloudflareAccessVerifier({ fetch })
    await expect(verify(await accessToken(), { audience, issuer })).resolves.toEqual({ email: "maintainer@example.com" })
    await expect(verify(await accessToken({ common_name: "client-id.access", email: "" }), { audience, issuer })).resolves.toEqual({ commonName: "client-id.access" })
    await expect(verify(await accessToken({ aud: "other-app" }), { audience, issuer })).resolves.toBeUndefined()
    await expect(verify(await accessToken({ iss: "https://other.cloudflareaccess.com" }), { audience, issuer })).resolves.toBeUndefined()
    await expect(verify(await accessToken({ exp: Math.floor(Date.now() / 1000) - 60 }), { audience, issuer })).resolves.toBeUndefined()
    await expect(verify("not-a-token", { audience, issuer })).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("RS256")
    const token = await new SignJWT({ email: "maintainer@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "access-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(other.privateKey)
    await expect(createCloudflareAccessVerifier({ fetch: certsFetch() })(token, { audience, issuer })).resolves.toBeUndefined()
  })

  it("refreshes Access keys immediately after signing-key rotation", async () => {
    const originalJwks = jwks
    vi.useFakeTimers()
    try {
      const fetch = certsFetch()
      const verify = createCloudflareAccessVerifier({ fetch })
      await expect(verify(await accessToken(), { audience, issuer })).resolves.toEqual({ email: "maintainer@example.com" })

      const rotated = await generateKeyPair("RS256", { extractable: true })
      jwks = { keys: [{ ...(await exportJWK(rotated.publicKey)), alg: "RS256", kid: "rotated-key", use: "sig" }] }
      const rotatedToken = await new SignJWT({ email: "maintainer@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "rotated-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(rotated.privateKey)

      await vi.advanceTimersByTimeAsync(1_100)
      await expect(verify(rotatedToken, { audience, issuer })).resolves.toEqual({ email: "maintainer@example.com" })
      expect(fetch).toHaveBeenCalledTimes(2)
    }
    finally {
      jwks = originalJwks
      vi.useRealTimers()
    }
  })

  it("bounds refreshes for repeated unknown signing keys", async () => {
    const fetch = certsFetch()
    const verify = createCloudflareAccessVerifier({ fetch })
    const tokens = await Promise.all(Array.from({ length: 3 }, async (_, index) => new SignJWT({ email: "attacker@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: `unknown-key-${index}` })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)))

    await Promise.all(tokens.map(async (token) => expect(verify(token, { audience, issuer })).resolves.toBeUndefined()))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("guards only Console routes and serves the Access identity", async () => {
    const verify = createCloudflareAccessVerifier({ fetch: certsFetch() })
    const settings = () => ({ audience, teamDomain })
    const token = await accessToken()
    expect(await handleCloudflareAccessConsoleRequest(consoleEvent("https://app.example.com/api/app"), settings, "/", verify)).toBeUndefined()
    expect(await handleCloudflareAccessConsoleRequest(consoleEvent("https://app.example.com/_vitehub", token), settings, "/", verify)).toBeUndefined()
    const identity = await handleCloudflareAccessConsoleRequest(consoleEvent("https://app.example.com/portal/api/_vitehub/console/auth/identity", token), settings, "/portal/", verify)
    expect(identity?.status).toBe(200)
    expect(identity?.headers.get("cache-control")).toBe("no-store")
    expect(await identity?.json()).toEqual({ email: "maintainer@example.com", signOutURL: "/cdn-cgi/access/logout" })
    expect((await handleCloudflareAccessConsoleRequest(consoleEvent("https://app.example.com/api/_vitehub/console/auth/identity", token, "POST"), settings, "/", verify))?.status).toBe(405)
    expect((await handleCloudflareAccessConsoleRequest(consoleEvent("https://app.example.com/portal/_vitehub"), settings, "/portal/", verify))?.status).toBe(401)
  })

  it("fails closed when the team domain or audience is missing or invalid", async () => {
    const verify = vi.fn<CloudflareAccessVerifier>()
    const event = consoleEvent("https://app.example.com/_vitehub", "token")
    expect((await handleCloudflareAccessConsoleRequest(event, () => ({ audience }), "/", verify))?.status).toBe(500)
    expect((await handleCloudflareAccessConsoleRequest(event, () => ({ audience, teamDomain: "http://insecure.example.com" }), "/", verify))?.status).toBe(500)
    expect((await handleCloudflareAccessConsoleRequest(event, () => { throw new Error("missing Env") }, "/", verify))?.status).toBe(500)
    expect(verify).not.toHaveBeenCalled()
  })

  it("bundles a generated guard that reads Env and verifies tokens on Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-access-node-"))
    try {
      const modulePath = resolve(root, "guard.mjs")
      await writeFile(modulePath, await bundleMiddleware(root, "node"))
      const fetch = certsFetch()
      vi.stubGlobal("fetch", fetch)
      vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain)
      vi.stubEnv("CF_ACCESS_AUD", audience)
      const guard = (await import(pathToFileURL(modulePath).href)) as { default: (event: { req: Request, url: URL }) => Promise<Response | undefined> }

      expect(await guard.default(consoleEvent("https://app.example.com/api/app"))).toBeUndefined()
      expect((await guard.default(consoleEvent("https://app.example.com/_vitehub")))?.status).toBe(401)
      expect(await guard.default(consoleEvent("https://app.example.com/_vitehub", await accessToken()))).toBeUndefined()
      expect(await guard.default(consoleEvent("https://app.example.com/api/_vitehub/console/status", await accessToken()))).toBeUndefined()
      expect((await guard.default(consoleEvent("https://app.example.com/_vitehub/rpc/stream", await accessToken({ aud: "other-app" }))))?.status).toBe(401)
      expect((await guard.default(consoleEvent("https://app.example.com/_vitehub", await accessToken({ iss: "https://other.cloudflareaccess.com" }))))?.status).toBe(401)
      expect((await guard.default(consoleEvent("https://app.example.com/_vitehub", await accessToken({ exp: Math.floor(Date.now() / 1000) - 60 }))))?.status).toBe(401)
      expect(fetch).toHaveBeenCalledTimes(1)

      vi.stubEnv("CF_ACCESS_AUD", "")
      expect((await guard.default(consoleEvent("https://app.example.com/_vitehub", await accessToken())))?.status).toBe(500)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("verifies the generated guard in workerd with Cloudflare Env bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-access-workerd-"))
    const certs = vi.fn(() => Response.json(jwks))
    const worker = new Miniflare({
      bindings: { CF_ACCESS_AUD: audience, CF_ACCESS_TEAM_DOMAIN: teamDomain },
      compatibilityDate: "2026-04-20",
      compatibilityFlags: ["nodejs_compat"],
      modulesRoot: root,
      modules: [
        {
          type: "ESModule",
          path: resolve(root, "worker.mjs"),
          contents: `
            import guard from "./guard.mjs";
            export default {
              async fetch(request, env) {
                const response = await guard({ env, req: request, url: new URL(request.url) });
                return response ?? new Response("next");
              }
            };
          `,
        },
        { type: "ESModule", path: resolve(root, "guard.mjs"), contents: await bundleMiddleware(root, "browser") },
      ],
      outboundService: (request: Request) => {
        if (request.url !== `${issuer}/cdn-cgi/access/certs`) return new Response("not found", { status: 404 })
        return certs()
      },
    })
    try {
      const allowed = await worker.dispatchFetch("https://app.example.com/_vitehub", { headers: { "cf-access-jwt-assertion": await accessToken() } })
      expect(await allowed.text()).toBe("next")
      const identity = await worker.dispatchFetch("https://app.example.com/api/_vitehub/console/auth/identity", { headers: { "cf-access-jwt-assertion": await accessToken() } })
      expect(await identity.json()).toEqual({ email: "maintainer@example.com", signOutURL: "/cdn-cgi/access/logout" })
      const missing = await worker.dispatchFetch("https://app.example.com/_vitehub")
      expect(missing.status).toBe(401)
      await missing.arrayBuffer()
      const wrongAudience = await worker.dispatchFetch("https://app.example.com/_vitehub", { headers: { "cf-access-jwt-assertion": await accessToken({ aud: "other-app" }) } })
      expect(wrongAudience.status).toBe(401)
      await wrongAudience.arrayBuffer()
      expect(certs).toHaveBeenCalledTimes(1)
    }
    finally {
      await worker.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it("resolves settings from Env declarations and literals", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-access-config-"))
    try {
      const defaults = resolveConsoleAuthConfig(root, { provider: "cloudflare-access" }, "cloudflare")
      expect(defaults).toMatchObject({
        provider: "cloudflare-access",
        settings: {
          audience: { required: true, secret: false, source: { kind: "env", name: "CF_ACCESS_AUD" } },
          teamDomain: { required: true, secret: false, source: { kind: "env", name: "CF_ACCESS_TEAM_DOMAIN" } },
        },
      })
      expect(resolveConsoleAuthConfig(root, {
        audience: env({ source: env.source("LABELLER_ACCESS_AUD") }),
        provider: "cloudflare-access",
        teamDomain,
      }, "node")).toMatchObject({
        settings: {
          audience: { source: { name: "LABELLER_ACCESS_AUD" } },
          teamDomain: { kind: "literal", value: teamDomain },
        },
      })
      expect(() => resolveConsoleAuthConfig(root, { provider: "cloudflare-access", teamDomain: "http://acme.example.com" }, "cloudflare"))
        .toThrow("teamDomain must be an HTTPS team domain")
      expect(() => resolveConsoleAuthConfig(root, { audience: " ", provider: "cloudflare-access" }, "cloudflare"))
        .toThrow("audience must be a non-empty Application Audience (AUD) tag")
      expect(() => resolveConsoleAuthConfig(root, { audience: env({ source: env.provider("vault", "access/aud") }), provider: "cloudflare-access" }, "cloudflare"))
        .toThrow("cannot use env.provider()")

      const handlers = await writeConsoleAuthHandlers(root, defaults)
      expect(handlers).toEqual({ auth: "cloudflare-access", clientSources: [], middleware: handlers.middleware })
      const middleware = await readFile(handlers.middleware, "utf8")
      expect(middleware).toContain('from "vite-hub/console/auth/cloudflare-access"')
      expect(middleware).toContain("resolveServerEnv(settings, event)")
      expect(middleware).not.toContain("#vitehub/auth/server")

      await mkdir(resolve(root, "vitehub/console/auth"), { recursive: true })
      await writeFile(resolve(root, "vitehub/console/auth/server.ts"), "export default {}")
      expect(() => resolveConsoleAuthConfig(root, { provider: "cloudflare-access" }, "cloudflare")).toThrow("conflicts with vitehub/console/auth/server")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("writes a guard using the Vite application base", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-access-base-"))
    try {
      const handlers = await writeConsoleAuthHandlers(root, resolveConsoleAuthConfig(root, { provider: "cloudflare-access" }, "cloudflare"), "/portal/")
      const middleware = await readFile(handlers.middleware, "utf8")
      expect(middleware).toContain('"/portal/"')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ["", ""],
    ["./", ""],
    ["/", ""],
    ["/portal/", "/portal"],
    ["https://assets.example.com/", ""],
    ["https://assets.example.com/portal/", "/portal"],
  ])("guards mounted Console routes with Vite base %j", async (base, mount) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-access-vite-base-"))
    try {
      const plugin = consoleVitePlugin({ console: { access: "auth", auth: { provider: "cloudflare-access", audience, teamDomain } }, preset: "cloudflare" })
      const hook = plugin.config
      if (!hook) throw new TypeError("Expected Console config hook.")
      const handler = "handler" in hook ? hook.handler : hook
      const config: { root: string, base: string, nitro?: { handlers: Array<{ handler: string, middleware?: boolean }> } } = { root, base }
      await Reflect.apply(handler, {}, [config, { command: "build", mode: "production" }])
      const middleware = config.nitro?.handlers.find(entry => entry.middleware)?.handler
      if (!middleware) throw new TypeError("Expected Console auth middleware.")
      const bundled = await bundleMiddleware(root, "node", middleware)
      const file = join(root, "guard.mjs")
      await writeFile(file, bundled)
      const { default: guard } = await import(pathToFileURL(file).href) as { default: (event: ReturnType<typeof consoleEvent>) => Promise<Response | undefined> }
      for (const path of ["/_vitehub", "/_vitehub/rpc/__call", "/api/_vitehub/console/auth/identity"]) {
        for (const method of ["GET", "POST"]) {
          expect((await guard(consoleEvent(`https://app.example.com${mount}${path}`, undefined, method)))?.status).toBe(401)
        }
      }
      expect(await guard(consoleEvent("https://app.example.com/api/app"))).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("guards the final mount when a later Vite plugin changes the base", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-access-vite-final-base-"))
    try {
      await resolveConfig({
        root,
        configFile: false,
        base: "/early/",
        plugins: [
          consoleVitePlugin({ console: { access: "auth", auth: { provider: "cloudflare-access", audience, teamDomain } }, preset: "cloudflare" }),
          { name: "change-console-base", config: () => ({ base: "/portal/" }) },
        ],
      }, "build", "production")
      const bundled = await bundleMiddleware(root, "node", resolve(root, ".vitehub/nitro/console/auth-middleware.mjs"))
      const file = join(root, "guard.mjs")
      await writeFile(file, bundled)
      const { default: guard } = await import(pathToFileURL(file).href) as { default: (event: ReturnType<typeof consoleEvent>) => Promise<Response | undefined> }
      for (const path of ["/_vitehub", "/_vitehub/rpc/__call", "/api/_vitehub/console/auth/identity"]) {
        for (const method of ["GET", "POST"]) {
          expect((await guard(consoleEvent(`https://app.example.com/portal${path}`, undefined, method)))?.status).toBe(401)
        }
      }
      expect(await guard(consoleEvent("https://app.example.com/api/app"))).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("registers only the Access guard in a Cloudflare production build and skips it in development", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-access-vite-"))
    try {
      const run = async (command: "build" | "serve") => {
        const plugin = consoleVitePlugin({ console: { access: "auth", auth: { provider: "cloudflare-access" } }, preset: "cloudflare" })
        const hook = plugin.config
        if (!hook) throw new TypeError("Expected Console config hook.")
        const handler = "handler" in hook ? hook.handler : hook
        const config: { root: string, nitro?: { handlers: Array<{ handler: string, route: string, middleware?: boolean }> } } = { root }
        await Reflect.apply(handler, {}, [config, { command, mode: command === "build" ? "production" : "development" }])
        return config.nitro?.handlers ?? []
      }
      const production = await run("build")
      expect(production).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "/**", middleware: true, handler: resolve(root, ".vitehub/nitro/console/auth-middleware.mjs") }),
        expect.objectContaining({ route: "/api/_vitehub/console/client.js", handler: expect.stringContaining("server/client.get.js") }),
      ]))
      expect(production.map(entry => entry.route)).not.toContain("/_vitehub/sign-in")
      expect(production.map(entry => entry.route)).not.toContain("/api/_vitehub/console/auth/**")
      expect(await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"], "cloudflare-access")`)

      const development = await run("serve")
      expect(development.some(entry => entry.middleware)).toBe(false)
      expect(await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"])`)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("warns when a Cloudflare production build uses host-managed exposure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cf-host-managed-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const run = async (preset: string) => {
        const plugin = consoleVitePlugin({ console: { exposure: "host-managed", authorize: hostManagedAuthorize }, preset })
        const configHook = plugin.config
        const resolvedHook = plugin.configResolved
        if (!configHook || !resolvedHook) throw new TypeError("Expected Console config hooks.")
        const warn = vi.fn()
        const config = { logger: { warn }, root }
        await Reflect.apply("handler" in configHook ? configHook.handler : configHook, {}, [config, { command: "build", mode: "production" }])
        await Reflect.apply("handler" in resolvedHook ? resolvedHook.handler : resolvedHook, {}, [config])
        return warn
      }
      expect(await run("cloudflare")).toHaveBeenCalledWith(expect.stringContaining('auth: { provider: "cloudflare-access" }'))
      expect(await run("node")).not.toHaveBeenCalled()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
