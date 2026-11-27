import { createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"

import { passkey } from "@better-auth/passkey"
import { createClient } from "@libsql/client"
import { authSqliteSchema } from "@vite-hub/auth/schema"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { createAuthMiddleware } from "better-auth/api"
import { organization } from "better-auth/plugins"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, describe, expect, it } from "vitest"

import { passkeySignUp, sessionTeam } from "../src/accounts.ts"
import { keepConsoleSignInMethod } from "../src/sign-in-methods.ts"

const origin = "http://localhost:3000"
const secret = "console-sign-in-method-tests-secret-1234567890"
const clients: ReturnType<typeof createClient>[] = []
afterEach(() => { clients.splice(0).forEach(client => client.close()) })

async function setup(concurrent = false) {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute("PRAGMA foreign_keys = ON")
  const db = drizzle({ client })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../server/databases/default/migrations/", import.meta.url)) })
  let arrivals = 0
  let release = () => {}
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const auth = betterAuth({
    baseURL: origin,
    secret,
    logger: { disabled: true },
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSqliteSchema }),
    databaseHooks: { session: { create: { async before(session, context) {
      return { data: { ...session, activeOrganizationId: await sessionTeam(session.userId, context) } }
    } } } },
    plugins: [
      organization(),
      passkey({ registration: passkeySignUp }),
      keepConsoleSignInMethod(),
      { id: "concurrent-deletions", hooks: { before: [{
        matcher: ctx => concurrent && ctx.path === "/passkey/delete-passkey",
        handler: createAuthMiddleware(async () => {
          if (++arrivals === 2) release()
          await barrier
        }),
      }] } },
    ],
  })
  const context = await auth.$context
  const user = await context.internalAdapter.createUser({ name: "Ada", email: "ada@passkey.invalid", emailVerified: false }, { method: "passkey" })
  for (const id of ["a", "b"]) await context.adapter.create({ model: "passkey", data: {
    id, userId: user.id, name: id, publicKey: "unused-for-deletion", credentialID: id, counter: 0, deviceType: "singleDevice", backedUp: false,
  }, forceAllowId: true })
  const session = await context.internalAdapter.createSession(user.id)
  const signed = `${session.token}.${createHmac("sha256", secret).update(session.token).digest("base64")}`
  const cookie = `better-auth.session_token=${encodeURIComponent(signed)}`
  const remove = (id: string) => auth.handler(new Request(`${origin}/api/auth/passkey/delete-passkey`, {
    method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ id }),
  }))
  const keys = () => context.adapter.findMany<{ id: string }>({ model: "passkey", where: [{ field: "userId", value: user.id }] })
  const github = () => context.adapter.create({ model: "account", data: { userId: user.id, providerId: "github", accountId: "github-ada", createdAt: new Date(), updatedAt: new Date() } })
  return { auth, client, context, user, cookie, remove, keys, github }
}

describe("Console sign-in methods", () => {
  it("rejects the stale second tab's deletion of the last passkey", async () => {
    const { remove, keys } = await setup()
    expect((await keys()).map(key => key.id).sort()).toEqual(["a", "b"])
    expect((await remove("a")).status).toBe(200)
    const last = await remove("b")
    expect(last.status).toBe(400)
    expect(await last.json()).toMatchObject({ code: "LAST_SIGN_IN_METHOD" })
    expect((await keys()).map(key => key.id)).toEqual(["b"])
  })

  it("keeps a passkey when both requests pass their checks before either deletes", async () => {
    const { remove, keys } = await setup(true)
    const responses = await Promise.all([remove("a"), remove("b")])
    expect(responses.filter(response => response.ok)).toHaveLength(1)
    expect(await keys()).toHaveLength(1)
  })

  it("allows removing all passkeys with GitHub, keeps that provider, and allows user deletion", async () => {
    const { remove, keys, github, context, user } = await setup()
    const linked = await github()
    expect((await remove("a")).status).toBe(200)
    expect((await remove("b")).status).toBe(200)
    expect(await keys()).toHaveLength(0)
    await expect(context.adapter.delete({ model: "account", where: [{ field: "id", value: linked.id }] })).rejects.toThrow()
    expect(await context.adapter.count({ model: "account" })).toBe(1)
    await context.adapter.delete({ model: "user", where: [{ field: "id", value: user.id }] })
    expect(await context.adapter.count({ model: "account" })).toBe(0)
  })

  it("keeps one method if provider unlink and last-passkey deletion race", async () => {
    const { remove, github, context, keys } = await setup()
    const linked = await github()
    expect((await remove("a")).status).toBe(200)
    await Promise.allSettled([
      remove("b"),
      context.adapter.delete({ model: "account", where: [{ field: "id", value: linked.id }] }),
    ])
    expect((await keys()).length + await context.adapter.count({ model: "account" })).toBe(1)
  })

  it("allows deleting a passkey-only user and cascades their keys", async () => {
    const { context, user, keys } = await setup()
    await context.adapter.delete({ model: "user", where: [{ field: "id", value: user.id }] })
    expect(await keys()).toHaveLength(0)
  })
})
