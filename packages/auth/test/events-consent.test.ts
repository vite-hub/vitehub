import * as v from "valibot"
import { APIError } from "better-auth"
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api"
import { organization } from "better-auth/plugins"
import { getMigrations } from "better-auth/db/migration"
import { afterEach, expect, it } from "vitest"
import { defineAuth, createDatabaseAuthEventStore } from "../src/index.ts"
import { createBetterAuthOptions, handleAuthRequest } from "../src/server.ts"
import { eventDatabase } from "./event-helpers.ts"
import type { BetterAuthPlugin } from "better-auth"

// Exercise the public adapter contract used by OAuth Provider 1.7.7, without a remote OAuth server.
// https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/consent.ts
// https://github.com/better-auth/better-auth/blob/v1.7.7/packages/oauth-provider/src/oauthConsent/endpoints.ts
const consentPlugin: BetterAuthPlugin = {
  id: "consent-contract-fixture",
  schema: { oauthConsent: { fields: { clientId: { type: "string" }, userId: { type: "string" } } } },
  endpoints: {
    consent: createAuthEndpoint("/oauth2/consent", { method: "POST", use: [sessionMiddleware], body: v.object({ accept: v.boolean() }) }, async ctx => {
      if (!ctx.body.accept) return ctx.json({ redirect: true, url: "https://client.example?error=access_denied" })
      const consent = await ctx.context.adapter.create<{ id: string, userId: string, clientId: string }>({ model: "oauthConsent", data: { userId: ctx.context.session.user.id, clientId: "client-id" } })
      return ctx.json({ id: consent.id, url: "https://client.example?code=private-code" })
    }),
    updateConsent: createAuthEndpoint("/oauth2/update-consent", { method: "POST", use: [sessionMiddleware], body: v.object({ id: v.string() }) }, async ctx => {
      return ctx.json(await ctx.context.adapter.update<{ id: string, userId: string, clientId: string }>({ model: "oauthConsent", where: [{ field: "id", value: ctx.body.id }, { field: "userId", value: ctx.context.session.user.id }], update: { clientId: "client-id" } }))
    }),
    deleteConsent: createAuthEndpoint("/oauth2/delete-consent", { method: "POST", use: [sessionMiddleware], body: v.object({ id: v.string() }) }, async ctx => {
      const where = [{ field: "id", value: ctx.body.id }, { field: "userId", value: ctx.context.session.user.id }]
      if (!await ctx.context.adapter.findOne({ model: "oauthConsent", where })) throw new APIError("NOT_FOUND")
      await ctx.context.adapter.delete({ model: "oauthConsent", where })
      return ctx.json({ success: true })
    }),
  },
}
const databases: ReturnType<typeof eventDatabase>[] = []
afterEach(() => databases.splice(0).forEach(db => db.sqlite.close()))
it("records actual consent writes and deletion, with no events for denied or rejected requests", async () => {
  const database = eventDatabase(); databases.push(database)
  const store = createDatabaseAuthEventStore({ db: database.db })
  const definition = defineAuth({
    runtime: { database: database.sqlite, secret: "auth-events-test-secret-12345678901234567890" },
    emailAndPassword: { enabled: true }, plugins: [consentPlugin, organization()], events: { store },
  })
  await (await getMigrations(createBetterAuthOptions(definition))).runMigrations()
  let cookie = ""
  const request = (path: string, body: object) => handleAuthRequest(definition, new Request(`http://localhost:3000/api/auth/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie }, body: JSON.stringify(body) }))
  const signup = await request("sign-up/email", { name: "Consent", email: "consent@example.com", password: "passwordpassword" })
  expect(signup.status).toBe(200)
  const user = await signup.json() as { user: { id: string } }
  cookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  expect((await request("organization/create", { name: "Team", slug: "team" })).status).toBe(200)
  expect((await request("oauth2/consent", { accept: false })).status).toBe(200)
  expect((await store.list({ type: "oauth.consent_granted" })).events).toEqual([])
  const granted = await request("oauth2/consent", { accept: true })
  expect(granted.status).toBe(200)
  const { id } = await granted.json() as { id: string }
  expect((await store.list({ type: "oauth.consent_granted" })).events).toMatchObject([{ userId: user.user.id, actor: `user:${user.user.id}`, metadata: { clientId: "client-id" } }])
  expect((await request("oauth2/update-consent", { id })).status).toBe(200)
  expect((await store.list({ type: "oauth.consent_granted" })).events).toHaveLength(2)
  expect((await request("oauth2/delete-consent", { id })).status).toBe(200)
  expect((await request("oauth2/delete-consent", { id })).status).toBe(404)
  const revoked = await store.list({ type: "oauth.consent_revoked" })
  expect(revoked.events).toMatchObject([{ actor: `user:${user.user.id}`, userId: user.user.id, metadata: { clientId: "client-id" } }])
  expect(JSON.stringify(await store.list())).not.toContain("private-code")
})
