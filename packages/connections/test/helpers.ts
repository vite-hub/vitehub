import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createDatabaseConnectionStore } from "../src/store.ts"

import type { ConnectionsRuntime } from "../src/runtime.ts"
import type { ConnectionStore } from "../src/store.ts"
import type { ConnectionAccessRule, ConnectionActionPattern, ConnectionDefinition, ConnectionProvider } from "../src/types.ts"

export interface MailApi {
  "labels.list": { method: "GET", body: never, params: { userId: string }, response: { labels: Array<{ id: string }> } }
  "messages.modify": { method: "POST", body: { addLabelIds?: string[] }, params: { id: string, userId: string }, response: { id: string } }
  "messages.send": { method: "POST", body: { raw: string }, params: { userId: string }, response: { id: string } }
}

export const ACCESS_TOKEN = "access-token-secret-1"
export const REFRESH_TOKEN = "refresh-token-secret-1"
export const CLIENT_SECRET = "client-secret-value"

export function testProvider(): ConnectionProvider<{ mail: MailApi }> {
  return {
    account: token => token.id_token ? { email: "owner@example.com", id: token.id_token } : undefined,
    apis: {
      mail: {
        highRisk: ["messages.send"],
        methods: {
          "labels.list": ["GET", "mail/v1/users/{userId}/labels", false],
          "messages.modify": ["POST", "mail/v1/users/{userId}/messages/{id}/modify", true],
          "messages.send": ["POST", "mail/v1/users/{userId}/messages/send", true],
        },
        rootUrl: "https://mail.example.com/",
      },
    },
    authorizationEndpoint: "https://auth.example.com/authorize",
    authorizationParams: { access_type: "offline" },
    clientId: "client-id",
    clientSecret: CLIENT_SECRET,
    id: "example",
    identityScopes: ["openid"],
    revocationEndpoint: "https://auth.example.com/revoke",
    tokenEndpoint: "https://auth.example.com/token",
  }
}

export interface FakeProvider {
  calls: Array<{ body?: string, headers: Headers, method: string, url: string }>
  fetch: typeof fetch
  /** Access tokens that the API accepts. */
  valid: Set<string>
  tokenResponses: Array<{ body: Record<string, unknown>, status?: number }>
}

export function fakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    calls: [],
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      const body = init?.body === undefined || init.body === null ? undefined : String(init.body)
      provider.calls.push({ ...(body === undefined ? {} : { body }), headers: new Headers(init?.headers), method: init?.method ?? "GET", url })
      if (url === "https://auth.example.com/token") {
        // Give concurrent callers a chance to overlap.
        await new Promise(resolve => setTimeout(resolve, 5))
        const next = provider.tokenResponses.shift() ?? { body: { error: "invalid_grant" }, status: 400 }
        return Response.json(next.body, { status: next.status ?? 200 })
      }
      if (url === "https://auth.example.com/revoke") return new Response(null, { status: 200 })
      const authorization = new Headers(init?.headers).get("authorization") ?? ""
      if (!provider.valid.has(authorization.replace(/^Bearer /, ""))) return Response.json({ error: { message: "Invalid credentials" } }, { status: 401 })
      if (url.includes("/labels")) return Response.json({ labels: [{ id: "INBOX" }] })
      return Response.json({ id: "message-1" })
    },
    tokenResponses: [],
    valid: new Set([ACCESS_TOKEN]),
  }
  return provider
}

export function mailConnection(access?: Record<string, ConnectionAccessRule<ConnectionActionPattern<{ mail: MailApi }>>>): ConnectionDefinition {
  return defineConnection({
    ...(access ? { access } : {}),
    api: { mail: ["labels.*", "messages.modify", "messages.send"] },
    provider: testProvider(),
    scopes: ["mail.modify"],
  }) as ConnectionDefinition
}

export function createStore(): ConnectionStore {
  const client = createClient({ url: ":memory:" })
  return createDatabaseConnectionStore({ db: drizzle(client), encryptionKey: new Uint8Array(32).fill(3) })
}

export interface TestRuntime {
  now: { value: number }
  provider: FakeProvider
  runtime: ConnectionsRuntime
  store: ConnectionStore
}

export function createTestRuntime(definition: ConnectionDefinition | (() => Promise<unknown>) = mailConnection(), store: ConnectionStore = createStore()): TestRuntime {
  const provider = fakeProvider()
  const now = { value: Date.parse("2026-09-29T10:00:00.000Z") }
  const runtime = createConnectionsRuntime({ definitions: { mail: definition }, fetch: provider.fetch, now: () => now.value, store })
  return { now, provider, runtime, store }
}

/** Run the authorization code flow against the fake provider. */
export async function connect(test: TestRuntime, token: Record<string, unknown> = {}): Promise<void> {
  const { state } = await test.runtime.authorize({ name: "mail", redirectUri: "http://127.0.0.1:8976/callback" })
  test.provider.tokenResponses.push({
    body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, scope: "openid mail.modify", token_type: "Bearer", ...token },
  })
  await test.runtime.complete({ code: "code-1", state })
}
