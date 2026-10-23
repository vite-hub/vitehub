import { bearer, jwt, magicLink } from "better-auth/plugins"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { stateless } from "../src/presets.ts"
import { resolveAuthOptions } from "../src/runtime-options.ts"
import { statelessUserId } from "../src/stateless-user-id.ts"
import { createAuth, getAuthForDefinition, handleAuthRequest, resetAuth } from "../src/server.ts"

const secret = "stateless-preset-test-secret-0123456789abcdef"
const origin = "https://app.example.com"

describe("stateless()", () => {
  it("reads maxAge as seconds or a duration", () => {
    expect(stateless()).toEqual({ name: "stateless", maxAge: 604_800 })
    expect(stateless({ maxAge: "12h" })).toEqual({ name: "stateless", maxAge: 43_200 })
    expect(stateless({ maxAge: 3600 })).toEqual({ name: "stateless", maxAge: 3600 })
  })

  it.each([0, -1, 1.5, "7 days", "7", ""])("rejects maxAge %j with AUTH_C0049", (maxAge) => {
    expect(() => stateless({ maxAge: maxAge as never })).toThrow(expect.objectContaining({ code: "AUTH_C0049" }))
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
    ["database metadata", { database: true }, "AUTH_C0044"],
    ["a named database", { database: { name: "auth" } }, "AUTH_C0044"],
    ["secondary storage", { secondaryStorage: { store: "auth" } }, "AUTH_C0045"],
    ["email and password", { emailAndPassword: { enabled: true } }, "AUTH_C0046"],
    ["a plugin with tables", { plugins: [jwt()] }, "AUTH_C0047"],
    ["a plugin with verification tokens", { plugins: [magicLink({ sendMagicLink: async () => {} })] }, "AUTH_C0047"],
    ["session.expiresIn", { session: { expiresIn: 60 } }, "AUTH_C0048"],
    ["session.cookieCache.strategy", { session: { cookieCache: { strategy: "compact" } } }, "AUTH_C0048"],
    ["account.storeStateStrategy", { account: { storeStateStrategy: "database" } }, "AUTH_C0048"],
  ] as const)("rejects %s when the Auth Definition is defined", (_name, options, code) => {
    expect(() => defineAuth({ ...options, preset: stateless() } as never)).toThrow(expect.objectContaining({ code }))
  })

  it("names the plugin that needs a database", () => {
    expect(() => defineAuth({ plugins: [jwt()], preset: stateless() })).toThrow(/"jwt"/)
  })

  it("accepts plugins that store nothing and disabled email and password", () => {
    expect(() => defineAuth({ emailAndPassword: { enabled: false }, plugins: [bearer()], preset: stateless() })).not.toThrow()
  })

  it("rejects a value that is not a preset with AUTH_C0043", () => {
    expect(() => defineAuth({ preset: { name: "custom" } } as never)).toThrow(expect.objectContaining({ code: "AUTH_C0043" }))
  })

  it("checks options that a callback or runtime adds when Auth resolves them", () => {
    const adapter = () => ({})
    const callback = defineAuth(() => ({ database: adapter as never, preset: stateless() }))
    expect(() => resolveAuthOptions(callback).providerOptions).toThrow(expect.objectContaining({ code: "AUTH_C0044" }))

    const runtime = defineAuth({ preset: stateless(), runtime: () => ({ emailAndPassword: { enabled: true } }) })
    expect(() => resolveAuthOptions(runtime).providerOptions).toThrow(expect.objectContaining({ code: "AUTH_C0046" }))
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

/** The provider account that the mocked GitHub and Discord APIs return. Each test sets it before it signs in. */
const providerAccount = { email: "octo@example.com", id: "42" }

/** Answers the GitHub and Discord token and user endpoints, so the OAuth callback runs without a network. */
function mockProviders() {
  const realFetch = globalThis.fetch
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  const token = { access_token: "provider-access-token", scope: "identify email", token_type: "bearer" }
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const { email, id } = providerAccount
    if (url.href === "https://github.com/login/oauth/access_token" || url.href === "https://discord.com/api/oauth2/token") return json(token)
    if (url.href === "https://api.github.com/user") return json({ avatar_url: "https://example.com/octo.png", email, id: Number(id), login: "octo", name: "Octo" })
    if (url.href === "https://api.github.com/user/emails") return json([{ email, primary: true, verified: true }])
    if (`${url.origin}${decodeURIComponent(url.pathname)}` === "https://discord.com/api/users/@me") return json({ avatar: null, discriminator: "0", email, global_name: "Octo", id, username: "octo", verified: true })
    return realFetch(input, init)
  })
}

/** Runs the browser side of a social sign-in: start, follow the provider redirect, and return the session cookies. */
async function signInWith(handle: (request: Request) => Promise<Response>, provider: "discord" | "github") {
  const jar = cookieJar()
  const signIn = await handle(new Request(`${origin}/api/auth/sign-in/social`, {
    body: JSON.stringify({ callbackURL: "/app", provider }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(signIn.status).toBe(200)
  jar.store(signIn)
  const state = new URL((await signIn.json() as { url: string }).url).searchParams.get("state")
  expect(state).toBeTruthy()

  const callback = await handle(new Request(`${origin}/api/auth/callback/${provider}?code=provider-code&state=${state}`, {
    headers: { cookie: jar.header() },
  }))
  expect(callback.status).toBe(302)
  expect(callback.headers.get("location")).toBe("/app")
  jar.store(callback)
  return jar
}

describe("stateless() sessions without a database", () => {
  afterEach(() => {
    resetAuth()
    vi.unstubAllGlobals()
    Object.assign(providerAccount, { email: "octo@example.com", id: "42" })
  })

  // Each request resolves the callback and creates a new Better Auth instance with an empty in-memory store,
  // so every request below runs like a fresh process or another replica.
  const definition = defineAuth(({ requestOrigin }) => ({
    baseURL: requestOrigin,
    preset: stateless({ maxAge: "7d" }),
    secret,
    socialProviders: {
      discord: { clientId: "discord-client", clientSecret: "discord-secret" },
      github: { clientId: "github-client", clientSecret: "github-secret" },
    },
  }))

  const handle = (request: Request) => handleAuthRequest(definition, request)

  async function readUserId(jar: ReturnType<typeof cookieJar>): Promise<string | undefined> {
    resetAuth()
    const session = await createAuth(definition, { baseURL: origin, secret }).api.getSession({ headers: new Headers({ cookie: jar.header() }) })
    return session?.user.id
  }

  it("signs in with a social provider and reads the session on a fresh instance", async () => {
    mockProviders()
    const jar = await signInWith(handle, "github")
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

  it("gives one provider account the same user ID on every sign-in and instance", async () => {
    mockProviders()
    const first = await readUserId(await signInWith(handle, "github"))
    const second = await readUserId(await signInWith(handle, "github"))
    expect(first).toBe(await statelessUserId("github", "42"))
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toBe(first)

    providerAccount.id = "43"
    expect(await readUserId(await signInWith(handle, "github"))).not.toBe(first)

    // Discord account 42 is a different person from GitHub account 42.
    providerAccount.id = "42"
    const discord = await readUserId(await signInWith(handle, "discord"))
    expect(discord).toBe(await statelessUserId("discord", "42"))
    expect(discord).not.toBe(first)
  })

  it("keeps the same user ID on a cached instance", async () => {
    mockProviders()
    const cached = defineAuth({
      preset: stateless(),
      runtime: { baseURL: origin, secret },
      socialProviders: { github: { clientId: "github-client", clientSecret: "github-secret" } },
    })
    const auth = getAuthForDefinition(cached)
    expect(getAuthForDefinition(cached)).toBe(auth)
    const ids = []
    for (let index = 0; index < 2; index++) {
      const jar = await signInWith(request => auth.handler(request), "github")
      ids.push((await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) }))?.user.id)
    }
    expect(ids).toEqual([await statelessUserId("github", "42"), await statelessUserId("github", "42")])
  })

  it("runs the application's user hooks around the stable ID", async () => {
    mockProviders()
    const validated: string[] = []
    const withHooks = defineAuth(({ requestOrigin }) => ({
      baseURL: requestOrigin,
      databaseHooks: { user: { create: { before: async user => ({ data: { ...user, id: "app-id", name: "From hook" } }) } } },
      preset: stateless(),
      secret,
      socialProviders: { github: { clientId: "github-client", clientSecret: "github-secret" } },
      user: {
        validateUserInfo: ({ source, user }) => {
          validated.push(`${source.action}:${user.email}`)
          return user.email === "blocked@example.com" ? { error: "blocked" } : undefined
        },
      },
    }))

    const jar = await signInWith(request => handleAuthRequest(withHooks, request), "github")
    const session = await createAuth(withHooks, { baseURL: origin, secret }).api.getSession({ headers: new Headers({ cookie: jar.header() }) })
    expect(session?.user).toMatchObject({ id: await statelessUserId("github", "42"), name: "From hook" })
    expect(validated).toEqual(["create-user:octo@example.com"])

    providerAccount.email = "blocked@example.com"
    const signIn = await handleAuthRequest(withHooks, new Request(`${origin}/api/auth/sign-in/social`, {
      body: JSON.stringify({ callbackURL: "/app", provider: "github" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))
    const blocked = cookieJar()
    blocked.store(signIn)
    const state = new URL((await signIn.json() as { url: string }).url).searchParams.get("state")
    const callback = await handleAuthRequest(withHooks, new Request(`${origin}/api/auth/callback/github?code=provider-code&state=${state}`, {
      headers: { cookie: blocked.header() },
    }))
    expect(callback.headers.get("location")).toContain("error=blocked")
  })
})
