import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { checkAuthMember, resetAuth } from "../src/internal/server.ts"

const db = vi.hoisted(() => ({ account: [] as Array<Record<string, unknown>>, session: [] as Array<Record<string, unknown>>, user: [] as Array<Record<string, unknown>>, verification: [] as Array<Record<string, unknown>> }))

// The app's discovered Definition, which `checkAuthMember()` reads.
vi.mock("#vitehub/auth/definition", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory")
  const { admin } = await import("better-auth/plugins")
  const { defineFixedAuth } = await import("./fixed-auth.ts")
  return { default: defineFixedAuth({ database: memoryAdapter(db), plugins: [admin()], socialProviders: { github: { clientId: "client", clientSecret: "secret" } } }) }
})

const now = new Date()

function addUser(id: string, email: string, options: { emailVerified?: boolean, role?: string, github?: { id: string, token?: string } } = {}) {
  db.user.push({ id, email, name: id, emailVerified: options.emailVerified ?? true, role: options.role ?? "user", createdAt: now, updatedAt: now })
  if (options.github) db.account.push({ id: `account-${id}`, userId: id, providerId: "github", accountId: options.github.id, accessToken: options.github.token, createdAt: now, updatedAt: now })
}

/** GitHub's membership endpoint: the token `gho_<org>` belongs to an active member of `<org>`. */
function stubGitHubMemberships(status?: number) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const org = /\/user\/memberships\/orgs\/(.+)$/.exec(url)?.[1]
    if (status) return new Response(null, { status })
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "")
    return token === `gho_${org}` ? Response.json({ state: "active" }) : new Response(null, { status: 404 })
  })
  vi.stubGlobal("fetch", fetch)
  return fetch
}

beforeEach(() => {
  for (const rows of Object.values(db)) rows.length = 0
  addUser("ada", "ada@example.com")
  addUser("eve", "eve@example.com", { emailVerified: false })
  addUser("owner", "owner@other.dev", { github: { id: "22072217" } })
  addUser("boss", "boss@other.dev", { role: "admin" })
  addUser("grace", "grace@other.dev", { github: { id: "7", token: "gho_acme" } })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetAuth()
})

describe("checkAuthMember()", () => {
  it("lets everyone in when VITEHUB_MEMBERS is not set", async () => {
    expect(await checkAuthMember("eve")).toEqual([undefined, undefined])
  })

  it("applies the sign-in rules: verified emails, domains, accounts, and admins", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "@example.com,github:22072217")
    expect(await checkAuthMember("ada")).toEqual([undefined, undefined])
    expect(await checkAuthMember("owner")).toEqual([undefined, undefined])
    expect(await checkAuthMember("boss")).toEqual([undefined, undefined])
    const [unverified] = await checkAuthMember("eve")
    expect(unverified?.code).toBe("AUTH_NOT_MEMBER")
    const [unknown] = await checkAuthMember("nobody")
    expect(unknown?.code).toBe("AUTH_NOT_MEMBER")
  })

  it("checks a GitHub organization with the stored token, and reuses a confirmed membership", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github-org:acme")
    const fetch = stubGitHubMemberships()
    expect(await checkAuthMember("grace", new Request("https://app.example.com/api/uploads/1"))).toEqual([undefined, undefined])
    expect(await checkAuthMember("grace")).toEqual([undefined, undefined])
    expect(fetch).toHaveBeenCalledOnce()
    const [error] = await checkAuthMember("ada")
    expect(error?.code).toBe("AUTH_NOT_MEMBER")
  })

  it("tells a GitHub outage from a refusal", async () => {
    vi.stubEnv("VITEHUB_MEMBERS", "github-org:outage")
    stubGitHubMemberships(503)
    const [error] = await checkAuthMember("grace")
    expect(error?.code).toBe("AUTH_GITHUB_UNAVAILABLE")
  })
})
