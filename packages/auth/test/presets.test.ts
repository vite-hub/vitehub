import { bearer, jwt, magicLink } from "better-auth/plugins"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { stateless } from "../src/presets.ts"
import { resolveAuthOptions } from "../src/runtime-options.ts"
import { createAuth, handleAuthRequest, resetAuth } from "../src/server.ts"

const secret = "stateless-preset-test-secret-0123456789abcdef"
const origin = "https://app.example.com"

describe("stateless()", () => {
  it("reads maxAge as seconds or a duration", () => {
    expect(stateless()).toEqual({ name: "stateless", maxAge: 604_800 })
    expect(stateless({ maxAge: "12h" })).toEqual({ name: "stateless", maxAge: 43_200 })
    expect(stateless({ maxAge: 3600 })).toEqual({ name: "stateless", maxAge: 3600 })
  })

  it.each([0, -1, 1.5, "7 days", "7", ""])("rejects maxAge %j with AUTH_C0047", (maxAge) => {
    expect(() => stateless({ maxAge: maxAge as never })).toThrow(expect.objectContaining({ code: "AUTH_C0047" }))
  })

  it("sets the Better Auth options for sessions without a database", () => {
    const definition = defineAuth({
      account: { encryptOAuthTokens: true },
      preset: stateless({ maxAge: "1d" }),
      session: { cookieCache: { version: "2" }, freshAge: 60 },
    })
    const options = resolveAuthOptions(definition).providerOptions

    expect(options).not.toHaveProperty("preset")
    expect(options.database).toBeUndefined()
    expect(options.session).toEqual({
      cookieCache: { enabled: true, maxAge: 86_400, refreshCache: true, strategy: "jwe", version: "2" },
      expiresIn: 86_400,
      freshAge: 60,
    })
    expect(options.account).toEqual({ encryptOAuthTokens: true, storeAccountCookie: true, storeStateStrategy: "cookie" })
  })
})

describe("stateless() conflicts", () => {
  it.each([
    ["database metadata", { database: true }, "AUTH_C0042"],
    ["a named database", { database: { name: "auth" } }, "AUTH_C0042"],
    ["secondary storage", { secondaryStorage: { store: "auth" } }, "AUTH_C0043"],
    ["email and password", { emailAndPassword: { enabled: true } }, "AUTH_C0044"],
    ["a plugin with tables", { plugins: [jwt()] }, "AUTH_C0045"],
    ["a plugin with verification tokens", { plugins: [magicLink({ sendMagicLink: async () => {} })] }, "AUTH_C0045"],
    ["session.expiresIn", { session: { expiresIn: 60 } }, "AUTH_C0046"],
    ["session.cookieCache.strategy", { session: { cookieCache: { strategy: "compact" } } }, "AUTH_C0046"],
    ["account.storeStateStrategy", { account: { storeStateStrategy: "database" } }, "AUTH_C0046"],
  ] as const)("rejects %s when the Auth Definition is defined", (_name, options, code) => {
    expect(() => defineAuth({ ...options, preset: stateless() } as never)).toThrow(expect.objectContaining({ code }))
  })

  it("names the plugin that needs a database", () => {
    expect(() => defineAuth({ plugins: [jwt()], preset: stateless() })).toThrow(/"jwt"/)
  })

  it("accepts plugins that store nothing and disabled email and password", () => {
    expect(() => defineAuth({ emailAndPassword: { enabled: false }, plugins: [bearer()], preset: stateless() })).not.toThrow()
  })

  it("rejects a value that is not a preset with AUTH_C0041", () => {
    expect(() => defineAuth({ preset: { name: "custom" } } as never)).toThrow(expect.objectContaining({ code: "AUTH_C0041" }))
  })

  it("checks options that a callback or runtime adds when Auth resolves them", () => {
    const adapter = () => ({})
    const callback = defineAuth(() => ({ database: adapter as never, preset: stateless() }))
    expect(() => resolveAuthOptions(callback).providerOptions).toThrow(expect.objectContaining({ code: "AUTH_C0042" }))

    const runtime = defineAuth({ preset: stateless(), runtime: () => ({ emailAndPassword: { enabled: true } }) })
    expect(() => resolveAuthOptions(runtime).providerOptions).toThrow(expect.objectContaining({ code: "AUTH_C0044" }))
  })
})

/** Collects cookies from responses like a browser, so later requests send them back. */
function cookieJar() {
  const cookies = new Map<string, string>()
  return {
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    names: () => [...cookies.keys()],
    store(response: Response) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = cookie.split(";")
        const index = pair.indexOf("=")
        const name = pair.slice(0, index).trim()
        if (attributes.some(attribute => /^\s*max-age=0\s*$/i.test(attribute))) cookies.delete(name)
        else cookies.set(name, pair.slice(index + 1))
      }
    },
  }
}

/** Answers GitHub's token and user endpoints, so the OAuth callback runs without a network. */
function mockGitHub() {
  const realFetch = globalThis.fetch
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href === "https://github.com/login/oauth/access_token") return json({ access_token: "github-access-token", scope: "read:user,user:email", token_type: "bearer" })
    if (url.href === "https://api.github.com/user") return json({ avatar_url: "https://example.com/octo.png", email: "octo@example.com", id: 42, login: "octo", name: "Octo" })
    if (url.href === "https://api.github.com/user/emails") return json([{ email: "octo@example.com", primary: true, verified: true }])
    return realFetch(input, init)
  })
}

describe("stateless() sessions without a database", () => {
  afterEach(() => {
    resetAuth()
    vi.unstubAllGlobals()
  })

  // Each request resolves the callback and creates a new Better Auth instance with an empty in-memory store,
  // so every request below runs like a fresh process or another replica.
  const definition = defineAuth(({ requestOrigin }) => ({
    baseURL: requestOrigin,
    preset: stateless({ maxAge: "7d" }),
    secret,
    socialProviders: { github: { clientId: "github-client", clientSecret: "github-secret" } },
  }))

  it("signs in with a social provider and reads the session on a fresh instance", async () => {
    mockGitHub()
    const jar = cookieJar()

    const signIn = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-in/social`, {
      body: JSON.stringify({ callbackURL: "/app", provider: "github" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))
    expect(signIn.status).toBe(200)
    jar.store(signIn)
    const { url } = await signIn.json() as { url: string }
    const state = new URL(url).searchParams.get("state")
    expect(state).toBeTruthy()

    const callback = await handleAuthRequest(definition, new Request(`${origin}/api/auth/callback/github?code=github-code&state=${state}`, {
      headers: { cookie: jar.header() },
    }))
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/app")
    jar.store(callback)
    // HTTPS adds the __Secure- prefix. The session data and the provider account are encrypted cookies.
    expect(jar.names().sort()).toEqual([
      "__Secure-better-auth.account_data",
      "__Secure-better-auth.session_data",
      "__Secure-better-auth.session_token",
    ])

    // Simulate a restart: drop every cached instance, then read the session over HTTP and through the server API.
    resetAuth()
    const session = await handleAuthRequest(definition, new Request(`${origin}/api/auth/get-session`, {
      headers: { cookie: jar.header() },
    }))
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user: { email: "octo@example.com", name: "Octo" } })

    const replica = createAuth(definition, { baseURL: origin, secret })
    const replicaSession = await replica.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
    expect(replicaSession?.user.email).toBe("octo@example.com")
    expect(replicaSession?.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000)

    // The cookie carries the session, so an instance with another secret cannot read it.
    const otherSecret = createAuth(definition, { baseURL: origin, secret: `${secret}-other` })
    expect(await otherSecret.api.getSession({ headers: new Headers({ cookie: jar.header() }) })).toBeNull()
  })
})
