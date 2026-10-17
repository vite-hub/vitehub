import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { memoryAdapter } from "better-auth/adapters/memory"
import { mergeConfig } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import hubAuthNuxt from "../src/nuxt.ts"
import { resolveAuthOptions } from "../src/runtime-options.ts"
import { createAuthAccessHandler, handleAuthRequest, resetAuth, withAuth } from "../src/server.ts"
import { createAuthNitroConfig, hubAuth } from "../src/vite.ts"

const roots: string[] = []
const secret = "abcdefghijklmnopqrstuvwxyz0123456789"

afterEach(async () => {
  resetAuth()
  vi.unstubAllGlobals()
  vi.resetModules()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-auth-base-"))
  roots.push(root)
  await mkdir(join(root, "server"), { recursive: true })
  await writeFile(join(root, "server", "auth.ts"), "import { defineAuth } from '@vite-hub/auth'\nexport default defineAuth({ appName: 'ViteHub' })\n")
  return root
}

describe("Auth below an application base path", () => {
  it("serves Better Auth routes and sessions below Nuxt app.baseURL without a configured baseURL", async () => {
    vi.stubGlobal("__VITEHUB_AUTH_APP_BASE_URL__", "/app/")
    const db: Record<string, unknown[]> = { account: [], session: [], user: [], verification: [] }
    const definition = defineAuth({
      appName: "ViteHub",
      emailAndPassword: { enabled: true },
      runtime: { database: memoryAdapter(db), secret },
    })
    const origin = "https://example.com"
    const headers = { "content-type": "application/json", origin }

    expect(resolveAuthOptions(definition, { request: new Request(`${origin}/app/api/auth/ok`) }).providerOptions.basePath).toBe("/app/api/auth")
    expect((await handleAuthRequest(definition, new Request(`${origin}/app/api/auth/ok`))).status).toBe(200)
    const signUp = await handleAuthRequest(definition, new Request(`${origin}/app/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: "base@example.com", name: "Base", password: "passwordpassword" }),
      headers,
      method: "POST",
    }))
    expect(signUp.status).toBe(200)
    const signIn = await handleAuthRequest(definition, new Request(`${origin}/app/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: "base@example.com", password: "passwordpassword" }),
      headers,
      method: "POST",
    }))
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
    const session = await handleAuthRequest(definition, new Request(`${origin}/app/api/auth/get-session`, { headers: { cookie } }))
    expect(await session.json()).toMatchObject({ user: { email: "base@example.com" } })
  })

  it("starts provider sign-in with callbacks below the application base path", async () => {
    vi.stubGlobal("__VITEHUB_AUTH_APP_BASE_URL__", "/app/")
    const definition = defineAuth({
      access: { signIn: { provider: "github" } },
      appName: "ViteHub",
      runtime: { secret, socialProviders: { github: { clientId: "github-client", clientSecret: "github-secret" } } },
    })

    const response = await withAuth(() => undefined, definition)(new Request("https://example.com/app/dashboard", {
      headers: { accept: "text/html" },
    }))

    expect(response?.status).toBe(302)
    const location = new URL(response?.headers.get("location") ?? "")
    expect(location.origin).toBe("https://github.com")
    expect(location.searchParams.get("redirect_uri")).toBe("https://example.com/app/api/auth/callback/github")
  })

  it("matches access routes below the application base path", async () => {
    vi.stubGlobal("__VITEHUB_AUTH_APP_BASE_URL__", "/app/")
    const definition = defineAuth({ access: { routes: ["/private/**"] }, appName: "ViteHub", runtime: { secret } })
    const access = createAuthAccessHandler([{ route: "/private/**" }], definition)

    expect((await access(new Request("https://example.com/app/private/page")))?.status).toBe(401)
    expect(await access(new Request("https://example.com/app/public"))).toBeUndefined()
  })

  it("keeps a base path that already includes the application base path", () => {
    vi.stubGlobal("__VITEHUB_AUTH_APP_BASE_URL__", "/app/")
    // Console Auth mounts its Definition below the app base path itself.
    const definition = defineAuth({ appName: "Console", basePath: "/app/api/_vitehub/console/auth" })

    expect(resolveAuthOptions(definition).providerOptions.basePath).toBe("/app/api/_vitehub/console/auth")
  })

  it("keeps root paths when no application base path is configured", () => {
    expect(resolveAuthOptions(defineAuth({ appName: "ViteHub" })).providerOptions.basePath).toBe("/api/auth")
  })

  it("sends default Vue client requests below the application base path", async () => {
    vi.stubGlobal("__VITEHUB_AUTH_APP_BASE_URL__", "/app/")
    const fetch = vi.fn(async () => Response.json(null))
    vi.stubGlobal("fetch", fetch)
    vi.stubGlobal("window", { location: new URL("https://example.com/app/") })
    const { authClient } = await import("../src/vue.ts")

    await authClient.getSession()

    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe("https://example.com/app/api/auth/get-session")
  })

  it("passes Nitro baseURL to Auth server code and the Vite client", async () => {
    const root = await createProject()
    const plugin = hubAuth()
    const input = { root, nitro: { baseURL: "/app/" } }
    // SAFETY: hubAuth defines a synchronous function config hook.
    const config = mergeConfig(input, (plugin.config as unknown as (config: typeof input) => Record<string, unknown>)(input))

    expect(config).toMatchObject({
      define: { __VITEHUB_AUTH_APP_BASE_URL__: JSON.stringify("/app/") },
      nitro: { replace: { __VITEHUB_AUTH_APP_BASE_URL__: JSON.stringify("/app/") } },
    })
    expect(createAuthNitroConfig(hubAuth(), { nitro: { baseURL: "/app/", replace: { KEEP: "1" } }, projectRoot: root })).toMatchObject({
      replace: { KEEP: "1", __VITEHUB_AUTH_APP_BASE_URL__: JSON.stringify("/app/") },
    })
  })

  it("ignores a Vite asset base when Nitro serves Auth at the root", async () => {
    const root = await createProject()
    const plugin = hubAuth()
    const input = { base: "/app/", root }
    // SAFETY: hubAuth defines a synchronous function config hook.
    const config = (plugin.config as unknown as (config: typeof input) => { define?: unknown, nitro?: unknown })(input)
    const nitro = (input as typeof input & { nitro?: { replace?: unknown } }).nitro

    expect(config.define).toBeUndefined()
    expect(nitro?.replace).toBeUndefined()
  })

  it("defines Nuxt app.baseURL for the default Vue client", () => {
    const nuxt = { options: { app: { baseURL: "/app/" }, rootDir: "/tmp/vitehub-auth-base-nuxt", vite: { define: { KEEP: "1" } } } }
    hubAuthNuxt({ env: false, nitro: false }, nuxt)

    expect(nuxt.options.vite.define).toEqual({ KEEP: "1", __VITEHUB_AUTH_APP_BASE_URL__: JSON.stringify("/app/") })
  })
})
