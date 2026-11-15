import { resolve } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { describe, expect, it, vi } from "vitest"

import type { GenericEndpointContext } from "better-auth"
import { adoptGitHubEmail, readConsoleAccount } from "../src/accounts.ts"
import { createConsoleProjectStore } from "../src/projects.ts"

function context(users: Record<string, { id: string, email: string }>) {
  const updateUser = vi.fn(async (id: string, data: { email: string }) => { users[id] = { ...users[id]!, ...data } })
  const internalAdapter = {
    findUserById: async (id: string) => users[id] ?? null,
    findUserByEmail: async (email: string) => {
      const user = Object.values(users).find(item => item.email === email)
      return user ? { user, accounts: [] } : null
    },
    updateUser,
  }
  const logger = { warn: vi.fn() }
  // SAFETY: The hook reads only these methods of the internal adapter and the logger.
  return { context: { context: { internalAdapter, logger } } as unknown as GenericEndpointContext, updateUser, logger }
}

const githubEmails = (emails: unknown) => vi.fn(async () => Response.json(emails))

describe("adoptGitHubEmail", () => {
  it("gives a passkey account the verified primary GitHub email", async () => {
    const users = { u1: { id: "u1", email: "u1@passkey.invalid" } }
    const { context: ctx, updateUser } = context(users)
    const fetcher = githubEmails([{ email: "other@example.com", primary: false, verified: true }, { email: "Ada@Example.com", primary: true, verified: true }])
    await adoptGitHubEmail({ userId: "u1", providerId: "github", accessToken: "token" }, ctx, fetcher)
    expect(updateUser).toHaveBeenCalledWith("u1", { email: "ada@example.com", emailVerified: true })
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token")
  })

  it("keeps a real email, and does not take an email that another account has", async () => {
    const real = context({ u1: { id: "u1", email: "ada@example.com" } })
    await adoptGitHubEmail({ userId: "u1", providerId: "github", accessToken: "token" }, real.context, githubEmails([{ email: "new@example.com", primary: true, verified: true }]))
    expect(real.updateUser).not.toHaveBeenCalled()

    const taken = context({ u1: { id: "u1", email: "u1@passkey.invalid" }, u2: { id: "u2", email: "ada@example.com" } })
    await adoptGitHubEmail({ userId: "u1", providerId: "github", accessToken: "token" }, taken.context, githubEmails([{ email: "ada@example.com", primary: true, verified: true }]))
    expect(taken.updateUser).not.toHaveBeenCalled()
  })

  it("ignores an unverified primary email, another provider, and a failed GitHub answer", async () => {
    const { context: ctx, updateUser } = context({ u1: { id: "u1", email: "u1@passkey.invalid" } })
    await adoptGitHubEmail({ userId: "u1", providerId: "github", accessToken: "token" }, ctx, githubEmails([{ email: "ada@example.com", primary: true, verified: false }]))
    await adoptGitHubEmail({ userId: "u1", providerId: "google", accessToken: "token" }, ctx, githubEmails([{ email: "ada@example.com", primary: true, verified: true }]))
    await adoptGitHubEmail({ userId: "u1", providerId: "github", accessToken: "token" }, ctx, vi.fn(async () => new Response("no", { status: 401 })))
    expect(updateUser).not.toHaveBeenCalled()
  })

  it("does not fail the GitHub link when the email lookup fails", async () => {
    const { context: ctx, updateUser, logger } = context({ u1: { id: "u1", email: "u1@passkey.invalid" } })
    await expect(adoptGitHubEmail({ userId: "u1", providerId: "github", accessToken: "token" }, ctx, vi.fn(async () => { throw new TypeError("network") }))).resolves.toBeUndefined()
    await expect(adoptGitHubEmail({ userId: "u1", providerId: "github", accessToken: "token" }, ctx, vi.fn(async () => new Response("not json")))).resolves.toBeUndefined()
    expect(updateUser).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it("takes the email when GitHub is connected again after a failed lookup", async () => {
    const users = { u1: { id: "u1", email: "u1@passkey.invalid" } }
    const { context: ctx, updateUser } = context(users)
    const account = { userId: "u1", providerId: "github", accessToken: "token" }
    await adoptGitHubEmail(account, ctx, vi.fn(async () => new Response("rate limited", { status: 403 })))
    expect(updateUser).not.toHaveBeenCalled()
    await adoptGitHubEmail({ ...account, accessToken: "new-token" }, ctx, githubEmails([{ email: "ada@example.com", primary: true, verified: true }]))
    expect(updateUser).toHaveBeenCalledWith("u1", { email: "ada@example.com", emailVerified: true })
  })
})

describe("readConsoleAccount", () => {
  const secret = "s".repeat(64)

  async function consoleDatabase() {
    const client = createClient({ url: ":memory:" })
    const db = drizzle({ client })
    await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../server/databases/default/migrations") })
    await client.executeMultiple(`
      INSERT INTO user (id, name, email) VALUES ('u1', 'Ada', 'ada@example.com'), ('u2', 'Bob', 'u2@passkey.invalid');
      INSERT INTO organization (id, name, slug, created_at) VALUES ('t1', 'Personal', 'personal-u1', 1), ('t2', 'Shop', 'shop', 2);
      INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 't1', 'u1', 'owner', 1), ('m2', 't2', 'u1', 'admin,member', 2), ('m3', 't2', 'u2', 'member', 3);
    `)
    return db
  }

  it("answers the teams, the roles in the session's team, and its projects", async () => {
    const db = await consoleDatabase()
    const shop = await createConsoleProjectStore(db, secret, "t2").create({ createdBy: "u1", url: "https://shop.example.com" })
    await createConsoleProjectStore(db, secret, "t1").create({ createdBy: "u1", url: "https://docs.example.com" })
    await expect(readConsoleAccount(db, { id: "u1", name: "Ada", email: "ada@example.com" }, "t2")).resolves.toEqual({
      user: { id: "u1", name: "Ada", email: "ada@example.com", image: null },
      hasEmail: true,
      teams: [{ id: "t1", name: "Personal", slug: "personal-u1" }, { id: "t2", name: "Shop", slug: "shop" }],
      teamId: "t2",
      roles: ["admin", "member"],
      projects: [shop],
    })
  })

  it("shows no projects of a team that the person is not a member of, and no email for a passkey account", async () => {
    const db = await consoleDatabase()
    await createConsoleProjectStore(db, secret, "t1").create({ createdBy: "u1", url: "https://docs.example.com" })
    await expect(readConsoleAccount(db, { id: "u2", name: "Bob", email: "u2@passkey.invalid" }, "t1")).resolves.toEqual({
      user: { id: "u2", name: "Bob", email: "u2@passkey.invalid", image: null },
      hasEmail: false,
      teams: [{ id: "t2", name: "Shop", slug: "shop" }],
      roles: [],
      projects: [],
    })
    await expect(readConsoleAccount(db, { id: "u2", name: "Bob", email: "u2@passkey.invalid" }, undefined)).resolves.toMatchObject({ projects: [], roles: [] })
  })
})
