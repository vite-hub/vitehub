import { memoryAdapter } from "better-auth/adapters/memory"
import { admin } from "better-auth/plugins"
import { createAccessControl } from "better-auth/plugins/access"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthConsole } from "../src/console-runtime.ts"
import { createAuthForRequest, resetAuth } from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

const origin = "https://app.example.com"
const github = { clientId: "client", clientSecret: "secret" }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetAuth()
})

/** GitHub's token, user, and email endpoints, answering for one GitHub account. */
function stubGitHub(account: { id: number, email: string }) {
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input] = args
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "token", token_type: "bearer", scope: "read:user,user:email" })
    if (url.href === "https://api.github.com/user") return Response.json({ id: account.id, login: "owner", name: "Owner", email: account.email, avatar_url: "" })
    if (url.href === "https://api.github.com/user/emails") return Response.json([{ email: account.email, primary: true, verified: true, visibility: "public" }])
    return await realFetch(...args)
  })
}

async function signUp(auth: ReturnType<typeof createAuthForRequest>, email: string) {
  const response = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email, name: email, password: "correct-horse-battery" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  return (body as { user: { id: string, role?: string } }).user
}

/** Runs Better Auth's GitHub sign-in or linking flow with GitHub's answers stubbed. */
async function githubOAuth(auth: ReturnType<typeof createAuthForRequest>, signedIn?: Response) {
  const previous = signedIn ? [signedIn] : []
  const start = await auth.handler(new Request(`${origin}/api/auth/${signedIn ? "link-social" : "sign-in/social"}`, {
    body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    headers: { "content-type": "application/json", origin, cookie: cookieHeader(...previous) },
    method: "POST",
  }))
  expect(start.status).toBe(200)
  const { url } = await start.json() as { url: string }
  const state = new URL(url).searchParams.get("state")
  const cookie = cookieHeader(...previous, start)
  const callback = await auth.handler(new Request(`${origin}/api/auth/callback/github?code=code&state=${state}`, { headers: { cookie } }))
  expect(callback.status).toBe(302)
  expect(callback.headers.get("location")).not.toContain("error")
  return callback
}

function cookieHeader(...responses: Response[]) {
  // Browsers keep the last value when a response writes a cookie more than once.
  const cookies = new Map<string, string>()
  for (const value of responses.flatMap(response => response.headers.getSetCookie())) {
    const pair = value.split(";")[0]!
    const name = pair.slice(0, pair.indexOf("="))
    if (/;\s*max-age=0(?:;|$)/i.test(value)) cookies.delete(name)
    else cookies.set(name, pair)
  }
  return [...cookies.values()].join("; ")
}

async function sessionOf(auth: ReturnType<typeof createAuthForRequest>, ...responses: Response[]) {
  const session = await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie: cookieHeader(...responses) } }))
  expect(session.status).toBe(200)
  return await session.json() as { user: { role?: string } }
}

async function roleOf(auth: ReturnType<typeof createAuthForRequest>, email: string) {
  const context = await auth.$context
  const found = await context.internalAdapter.findUserByEmail(email)
  return found ? Reflect.get(found.user, "role") : undefined
}

describe("VITEHUB_ADMINS", () => {
  it.each([undefined, "compact", "jwt", "jwe"] as const)("gives the admin role to a listed GitHub account on its first sign-in (cache: %s)", async (strategy) => {
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    stubGitHub({ id: 22072217, email: "owner@example.com" })
    const auth = createAuthForRequest(defineFixedAuth({
      emailAndPassword: { enabled: true },
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      session: { cookieCache: { enabled: strategy !== undefined, strategy } },
      socialProviders: { github },
      plugins: [admin()],
    }), new Request(origin))
    const response = await githubOAuth(auth)
    expect(await roleOf(auth, "owner@example.com")).toBe("admin")
    if (strategy) expect(response.headers.getSetCookie().some(cookie => cookie.includes("better-auth.session_data="))).toBe(true)
    expect((await sessionOf(auth, response)).user.role).toBe("admin")
  })

  it("does not give the role to a password sign-up with the admin's email", async () => {
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    const auth = createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true }, socialProviders: { github }, plugins: [admin()] }), new Request(origin))
    expect((await signUp(auth, "owner@example.com")).role).toBe("user")
  })

  it("does not give the role to another GitHub account", async () => {
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    stubGitHub({ id: 1, email: "guest@example.com" })
    const auth = createAuthForRequest(defineAuth({ socialProviders: { github }, plugins: [admin()] }), new Request(origin))
    await githubOAuth(auth)
    expect(await roleOf(auth, "guest@example.com")).toBe("user")
  })

  it.each([undefined, "compact", "jwt", "jwe"] as const)("gives the role on the next sign-in when the entry is added later (cache: %s)", async (strategy) => {
    stubGitHub({ id: 22072217, email: "owner@example.com" })
    const definition = defineFixedAuth({
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      session: { cookieCache: { enabled: strategy !== undefined, strategy } },
      socialProviders: { github },
      plugins: [admin()],
    })
    const before = createAuthForRequest(definition, new Request(origin))
    const first = await githubOAuth(before)
    expect(await roleOf(before, "owner@example.com")).toBe("user")
    expect((await sessionOf(before, first)).user.role).toBe("user")
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    const after = createAuthForRequest(definition, new Request(origin))
    const response = await githubOAuth(after)
    expect(await roleOf(after, "owner@example.com")).toBe("admin")
    if (strategy) expect(response.headers.getSetCookie().some(cookie => cookie.includes("better-auth.session_data="))).toBe(true)
    expect((await sessionOf(after, response)).user.role).toBe("admin")
  })

  it.each([["compact", false], ["jwt", false], ["jwe", false], ["compact", true]] as const)("updates the active session after linking a listed account (cache: %s, chunked: %s)", async (strategy, chunked) => {
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    stubGitHub({ id: 22072217, email: "owner@example.com" })
    const auth = createAuthForRequest(defineFixedAuth({
      emailAndPassword: { enabled: true },
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      session: { cookieCache: { enabled: true, strategy } },
      socialProviders: { github },
      plugins: [admin()],
    }), new Request(origin))
    const user = await signUp(auth, "owner@example.com")
    if (chunked) await (await auth.$context).internalAdapter.updateUser(user.id, { name: "Owner".repeat(2000) })
    const signedIn = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email: "owner@example.com", password: "correct-horse-battery" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))
    expect(signedIn.status).toBe(200)
    if (chunked) expect(signedIn.headers.getSetCookie().some(cookie => cookie.includes("better-auth.session_data.0="))).toBe(true)
    expect((await sessionOf(auth, signedIn)).user.role).toBe("user")
    const linked = await githubOAuth(auth, signedIn)
    expect(await roleOf(auth, "owner@example.com")).toBe("admin")
    expect((await sessionOf(auth, signedIn, linked)).user.role).toBe("admin")
  })

  it("gives the role when a listed account is linked to an existing user, and keeps other roles", async () => {
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    const ac = createAccessControl({ user: ["list"] })
    const roles = { owner: ac.newRole({ user: ["list"] }), editor: ac.newRole({}), member: ac.newRole({}) }
    const auth = createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin({ ac, roles, adminRoles: ["owner"], defaultRole: "member" })] }), new Request(origin))
    const user = await signUp(auth, "owner@example.com")
    const context = await auth.$context
    await context.internalAdapter.updateUser(user.id, { role: "member,editor" })
    await context.internalAdapter.linkAccount({ providerId: "github", accountId: "22072217", userId: user.id })
    expect(await roleOf(auth, "owner@example.com")).toBe("editor,owner")
  })

  it("shows the rule in the Auth Console", async () => {
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217, google:1094")
    const auth = createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()] }), new Request(origin))
    const [error, description] = await createAuthConsole(auth).describe()
    expect(error).toBeUndefined()
    expect(description?.access).toContain("VITEHUB_ADMINS gives the admin role to github:22072217, google:1094 on sign-in.")
  })

  it("needs Better Auth's admin() plugin, which stores the role", () => {
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    expect(() => createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true } }), new Request(origin))).toThrow(/AUTH_C0051|admin\(\)/)
  })

  it.each([
    ["owner@example.com", /email/],
    ["email:owner@example.com", /email/],
    ["github:onmax", /numeric account id/],
    ["github", /no provider or no account id/],
  ])("refuses the entry %s", (entry, message) => {
    vi.stubEnv("VITEHUB_ADMINS", entry)
    expect(() => createAuthForRequest(defineAuth({ plugins: [admin()] }), new Request(origin))).toThrow(message)
  })

  it("refuses the removed VITEHUB_ADMIN_EMAILS", () => {
    vi.stubEnv("VITEHUB_ADMIN_EMAILS", "owner@example.com")
    expect(() => createAuthForRequest(defineAuth({ plugins: [admin()] }), new Request(origin))).toThrow(/AUTH_C0057|VITEHUB_ADMINS/)
  })

  it("changes nothing when the variable is not set", async () => {
    const auth = createAuthForRequest(defineAuth({ emailAndPassword: { enabled: true }, plugins: [admin()] }), new Request(origin))
    expect((await signUp(auth, "owner@example.com")).role).toBe("user")
  })
})
