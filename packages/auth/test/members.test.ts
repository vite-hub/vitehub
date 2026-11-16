import { memoryAdapter } from "better-auth/adapters/memory"
import { admin } from "better-auth/plugins"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthConsole } from "../src/console-runtime.ts"
import { createAuthForRequest, resetAuth } from "../src/internal/server.ts"
import { stateless } from "../src/presets.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

const origin = "https://app.example.com"
const github = { clientId: "client", clientSecret: "secret" }

type Auth = ReturnType<typeof createAuthForRequest>
interface Row { [key: string]: unknown }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetAuth()
})

/** GitHub's token, user, email, and organization membership endpoints, answering for one GitHub account. */
function stubGitHub(account: { id: number, email: string, verified?: boolean, orgs?: Record<string, number> }) {
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input] = args
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: `gho_${account.id}`, token_type: "bearer", scope: "read:user,user:email,read:org" })
    if (url.href === "https://api.github.com/user") return Response.json({ id: account.id, login: "person", name: "Person", email: account.email, avatar_url: "" })
    if (url.href === "https://api.github.com/user/emails") return Response.json([{ email: account.email, primary: true, verified: account.verified ?? true, visibility: "public" }])
    const membership = /^https:\/\/api\.github\.com\/user\/memberships\/orgs\/(.+)$/.exec(url.href)
    if (membership) {
      const status = account.orgs?.[decodeURIComponent(membership[1]!)] ?? 404
      return status === 200 ? Response.json({ state: "active" }) : new Response(null, { status })
    }
    return await realFetch(...args)
  })
}

function createMembersAuth(options: { plugins?: ReturnType<typeof admin>[] } = {}) {
  const db: Record<string, Row[]> = { account: [], session: [], user: [], verification: [] }
  const definition = defineFixedAuth({
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    socialProviders: { github },
    plugins: options.plugins ?? [],
  })
  return { db, definition, auth: () => createAuthForRequest(definition, new Request(origin)) }
}

function cookieHeader(...responses: Response[]) {
  const cookies = new Map<string, string>()
  for (const value of responses.flatMap(response => response.headers.getSetCookie())) {
    const pair = value.split(";")[0]!
    const name = pair.slice(0, pair.indexOf("="))
    if (/;\s*max-age=0(?:;|$)/i.test(value)) cookies.delete(name)
    else cookies.set(name, pair)
  }
  return [...cookies.values()].join("; ")
}

/** Runs Better Auth's GitHub sign-in with GitHub's answers stubbed, and returns the callback and the authorize URL. */
async function githubSignIn(auth: Auth) {
  const start = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
    body: JSON.stringify({ provider: "github", callbackURL: "/", errorCallbackURL: "/sign-in" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(start.status).toBe(200)
  const { url } = await start.json() as { url: string }
  const state = new URL(url).searchParams.get("state")
  const callback = await auth.handler(new Request(`${origin}/api/auth/callback/github?code=code&state=${state}`, { headers: { cookie: cookieHeader(start) } }))
  expect(callback.status).toBe(302)
  return { callback, authorizeURL: new URL(url), error: new URL(callback.headers.get("location")!, origin).searchParams.get("error") }
}

async function sessionOf(auth: Auth, response: Response) {
  const session = await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie: cookieHeader(response) } }))
  return await session.json() as { user: { email: string } } | null
}

function signUp(auth: Auth, email: string) {
  return auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email, name: email, password: "correct-horse-battery" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
}

describe("VITEHUB_MEMBERS", () => {
  it("lets a listed GitHub account sign up, and refuses another one without keeping its user", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github:22072217")
    const { db, auth } = createMembersAuth()

    stubGitHub({ id: 22072217, email: "ada@example.com" })
    const member = await githubSignIn(auth())
    expect(member.error).toBeNull()
    expect(await sessionOf(auth(), member.callback)).toMatchObject({ user: { email: "ada@example.com" } })

    stubGitHub({ id: 1, email: "eve@example.com" })
    const stranger = await githubSignIn(auth())
    expect(stranger.error).toBe("AUTH_NOT_MEMBER")
    expect(stranger.callback.headers.get("location")).toContain("/sign-in?")
    expect(db.user!.map(user => user.email)).toEqual(["ada@example.com"])
    expect(db.account).toHaveLength(1)
  })

  it.each([["ada@example.com"], ["@example.com"]])("lets in the verified email %s", async (entry) => {
    vi.stubEnv("VITEHUB_MEMBERS", entry)
    const { auth } = createMembersAuth()
    stubGitHub({ id: 22072217, email: "ada@example.com" })
    expect((await githubSignIn(auth())).error).toBeNull()
  })

  it("does not count an email that the provider did not verify", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "ada@example.com")
    const { db, auth } = createMembersAuth()

    const response = await signUp(auth(), "ada@example.com")

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "AUTH_NOT_MEMBER" })
    expect(db.session).toHaveLength(0)
  })

  it("refuses a password sign-up with an email that no entry lists, and creates no user", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "ada@example.com")
    const { db, auth } = createMembersAuth()

    const response = await signUp(auth(), "eve@example.com")

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "AUTH_NOT_MEMBER" })
    expect(db.user).toHaveLength(0)
  })

  it("lets in an active member of a GitHub organization, and asks GitHub for read:org", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github-org:acme")
    const { db, auth } = createMembersAuth()

    stubGitHub({ id: 22072217, email: "ada@example.com", orgs: { acme: 200 } })
    const member = await githubSignIn(auth())
    expect(member.error).toBeNull()
    expect(member.authorizeURL.searchParams.get("scope")?.split(" ")).toContain("read:org")

    stubGitHub({ id: 1, email: "eve@example.com", orgs: { other: 200 } })
    expect((await githubSignIn(auth())).error).toBe("AUTH_NOT_MEMBER")
    expect(db.user).toHaveLength(1)
  })

  it("refuses an organization sign-up while GitHub is down, and keeps no user", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github-org:acme")
    const { db, auth } = createMembersAuth()
    stubGitHub({ id: 22072217, email: "ada@example.com", orgs: { acme: 503 } })

    expect((await githubSignIn(auth())).error).toBe("AUTH_GITHUB_UNAVAILABLE")
    expect(db.user).toHaveLength(0)
  })

  it("keeps the session of an organization member while GitHub is down, and fails the request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.stubEnv("VITEHUB_MEMBERS", "github-org:acme")
    stubGitHub({ id: 22072217, email: "ada@example.com", orgs: { acme: 200 } })
    const { db, auth } = createMembersAuth()
    const { callback } = await githubSignIn(auth())

    stubGitHub({ id: 22072217, email: "ada@example.com", orgs: { acme: 503 } })
    vi.advanceTimersByTime(300_001)
    const response = await auth().handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie: cookieHeader(callback) } }))

    expect(response.status).toBe(503)
    expect(db.session).toHaveLength(1)
  })

  it("refuses the next sign-in and ends the running session of a person removed from the list", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github:22072217")
    stubGitHub({ id: 22072217, email: "ada@example.com" })
    const { db, auth } = createMembersAuth()
    const { callback } = await githubSignIn(auth())
    expect(await sessionOf(auth(), callback)).not.toBeNull()

    vi.stubEnv("VITEHUB_MEMBERS", "github:1")

    expect(await sessionOf(auth(), callback)).toBeNull()
    expect(db.session).toHaveLength(0)
    expect((await githubSignIn(auth())).error).toBe("AUTH_NOT_MEMBER")
  })

  it("always lets in the accounts of VITEHUB_ADMINS", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "ada@example.com")
    vi.stubEnv("VITEHUB_ADMINS", "github:22072217")
    stubGitHub({ id: 22072217, email: "owner@example.com" })
    const { auth } = createMembersAuth({ plugins: [admin()] })

    expect((await githubSignIn(auth())).error).toBeNull()
  })

  it("shows the list in the Auth Console", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github:22072217, @acme.com")
    const { auth } = createMembersAuth()
    const [error, description] = await createAuthConsole(auth()).describe()
    expect(error).toBeUndefined()
    expect(description?.access).toContain("VITEHUB_MEMBERS lets only github:22072217, @acme.com and the admins sign up and sign in.")
  })

  it.each([
    ["octocat", /not an email, a domain/],
    ["github:octocat", /numeric account id/],
    ["email:ada@example.com", /email alone/],
    ["@", /domain entry/],
  ])("refuses the entry %s", (entry, message) => {
    vi.stubEnv("VITEHUB_MEMBERS", entry)
    expect(() => createMembersAuth().auth()).toThrow(expect.objectContaining({ code: "AUTH_MEMBERS_ENTRY_INVALID", message: expect.stringMatching(message) }))
  })

  it("needs a session store, because it ends the sessions of people who leave the list", () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github:22072217")
    const definition = defineAuth(() => ({ preset: stateless(), socialProviders: { github }, secret: "vitehub-members-test-secret-4d1c9b7e2a" }))
    expect(() => createAuthForRequest(definition, new Request(origin))).toThrow(expect.objectContaining({ code: "AUTH_MEMBERS_SESSION_STORE_REQUIRED" }))
  })

  it("lets everyone in when the variable is not set", async () => {
    const { auth } = createMembersAuth()
    expect((await signUp(auth(), "eve@example.com")).status).toBe(200)
  })
})
