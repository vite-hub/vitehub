import { createAgentEnvIdentity } from "../src/internal/env-identity.ts"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { expect, it } from "vitest"

import { defineConnection } from "../../connections/src/definition.ts"
import { google } from "../../connections/src/google.ts"
import { createConnectionsRuntime } from "../../connections/src/runtime.ts"
import { createDatabaseConnectionStore } from "../../connections/src/store.ts"
import { gmail } from "../src/capabilities/gmail.ts"
import { defineAgent, runAgent } from "../src/index.ts"
import { agentInvocationTraceIdContextKey } from "../src/trace.ts"

import type { AgentToolDefinition } from "../src/types.ts"

const scopes = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]

async function fixture(rule: { read?: boolean, write?: readonly string[], approve?: boolean } = { read: true, write: ["gmail.users.drafts.create"], approve: false }) {
  const database = createClient({ url: ":memory:" })
  const store = createDatabaseConnectionStore({ db: drizzle(database), encryptionKey: new Uint8Array(32).fill(3) })
  const requests: Array<{ body?: string, method: string, signal?: AbortSignal | null, url: URL }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push({ body: init?.body ? String(init.body) : undefined, method: init?.method ?? "GET", signal: init?.signal, url })
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "fake-token", expires_in: 3600, refresh_token: "fake-refresh", scope: scopes.join(" "), token_type: "Bearer" })
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-token")
    if (url.pathname === "/gmail/v1/users/me/messages") return Response.json({ messages: [{ id: "m1", threadId: "t1" }] })
    if (url.pathname === "/gmail/v1/users/me/messages/m1") {
      return Response.json({ id: "m1", payload: { body: { data: btoa("Hello") }, headers: [{ name: "Subject", value: "Hello" }], mimeType: "text/plain" }, threadId: "t1" })
    }
    if (url.pathname === "/gmail/v1/users/me/drafts" && init?.method === "POST") {
      return Response.json({ id: "d1", message: { id: "m2", threadId: "t1" } })
    }
    throw new Error(`Unexpected fake provider request: ${url}`)
  }
  const definition = defineConnection({
    access: { "agent:labeller": rule as never },
    api: { gmail: ["users.messages.list", "users.messages.get", "users.messages.attachments.get", "users.drafts.create"] },
    provider: google({ clientId: "fake-client", clientSecret: "fake-secret" }),
    scopes,
  })
  const createRuntime = () => createConnectionsRuntime({ definitions: { google: definition } as never, fetch, store })
  const runtime = createRuntime()
  const { state } = await runtime.authorize({ name: "google", redirectUri: "http://localhost/callback" })
  await runtime.complete({ code: "fake-code", state })
  const tools = async (active = runtime, name = "labeller") => {
    const capability = gmail({ operations: ["search", "read", "draft"] })
    if (typeof capability.tools !== "function") throw new Error("Missing Gmail tools")
    // SAFETY: Gmail reads only these fields from the Invocation context.
    return await capability.tools({
      agentIdentity: createAgentEnvIdentity({ name }),
      capabilities: { connections: { runtime: () => active } },
      context: new Map([[agentInvocationTraceIdContextKey, "invocation-1"]]),
    } as never) as Record<string, AgentToolDefinition>
  }
  return { close: () => database.close(), createRuntime, requests, runtime, tools }
}

it("gives an Agent only the Connection access of its own Agent Definition", async () => {
  const test = await fixture()
  try {
    const tools = await test.tools(test.runtime, "other")
    await expect(execute(tools.gmail_search, { max: 5, query: "in:inbox" })).rejects.toMatchObject({ code: "CONNECTION_DENIED" })
    expect(test.requests.some(request => request.url.pathname.endsWith("/messages"))).toBe(false)
    expect(await test.runtime.activity({ name: "google" })).toContainEqual(expect.objectContaining({ actor: { id: "other", kind: "agent" }, outcome: "denied" }))
  }
  finally { test.close() }
})

async function execute(tool: AgentToolDefinition | undefined, input: unknown): Promise<unknown> {
  if (!tool?.execute) throw new Error("Missing Gmail tool")
  return await tool.execute(input as never, {} as never)
}

it("searches, reads, and creates unsent drafts with the real Connections client", async () => {
  const test = await fixture()
  try {
    const tools = await test.tools()
    expect(await execute(tools.gmail_search, { max: 5, query: "in:inbox" })).toMatchObject({ messages: [{ id: "m1", subject: "Hello" }] })
    expect(await execute(tools.gmail_read, { id: "m1" })).toMatchObject({ text: "Hello" })
    expect(await execute(tools.gmail_draft, { body: "Thanks", subject: "Hello", to: ["owner@example.com"] })).toMatchObject({ draftId: "d1", sent: false })
    const list = test.requests.find(request => request.url.pathname.endsWith("/messages"))!
    expect(list.url.searchParams.get("maxResults")).toBe("5")
    const draft = test.requests.find(request => request.url.pathname.endsWith("/drafts"))!
    expect(JSON.parse(draft.body!)).toMatchObject({ message: { raw: expect.any(String) } })
    expect(test.requests.some(request => request.url.pathname.endsWith("/send"))).toBe(false)
    expect(await test.runtime.activity({ name: "google" })).toContainEqual(expect.objectContaining({ actor: { id: "labeller", kind: "agent" }, invocationId: "invocation-1", operation: "gmail.users.drafts.create", outcome: "succeeded" }))
    expect((await test.runtime.inspect("google")).actions.some(action => action.id.endsWith(".send"))).toBe(false)
  }
  finally { test.close() }
})

it("keeps the grant across fresh Agent tool resolution", async () => {
  const test = await fixture()
  try {
    const tools = await test.tools(test.createRuntime())
    expect(await execute(tools.gmail_read, { id: "m1" })).toMatchObject({ text: "Hello" })
    expect(test.requests.filter(request => request.url.hostname === "oauth2.googleapis.com")).toHaveLength(1)
  }
  finally { test.close() }
})

it("denies a Gmail read before calling the provider and records the denial", async () => {
  const test = await fixture({ read: false, write: [], approve: false })
  try {
    const tools = await test.tools()
    await expect(execute(tools.gmail_read, { id: "m1" })).rejects.toMatchObject({ code: "CONNECTION_DENIED" })
    expect(test.requests).toHaveLength(1)
    expect(await test.runtime.activity({ name: "google" })).toContainEqual(expect.objectContaining({ operation: "gmail.users.messages.get", outcome: "denied" }))
  }
  finally { test.close() }
})

it("persists a draft approval and executes it once through Connections", async () => {
  const test = await fixture({ read: true, write: ["gmail.users.drafts.create"], approve: true })
  try {
    const tools = await test.tools()
    await expect(execute(tools.gmail_draft, { body: "Thanks", subject: "Hello", to: ["owner@example.com"] })).rejects.toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    expect(test.requests).toHaveLength(1)
    const [approval] = (await test.runtime.approvals({ status: "pending" })).approvals
    expect(approval).toMatchObject({ action: "gmail.users.drafts.create", actor: "agent:labeller", invocationId: "invocation-1" })
    expect(await test.runtime.approve({ actor: "user:owner", id: approval!.id })).toMatchObject({ approval: { status: "executed" }, result: { id: "d1" } })
    await expect(test.runtime.approve({ id: approval!.id })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.requests.filter(request => request.url.pathname.endsWith("/drafts"))).toHaveLength(1)
  }
  finally { test.close() }
})

it("rejects a caller-selected Connection identity on an unnamed public Agent invocation", async () => {
  const test = await fixture()
  try {
    const agent = defineAgent({
      runtime: false,
      capabilities: [gmail()],
      driver: { async run(context) {
        return await execute(context.tools?.gmail_search, { max: 5, query: "in:inbox" })
      } },
    })
    await expect(runAgent(agent, {
      agentIdentity: { name: "labeller" },
      runtime: "unknown", memo: (_key, fn) => fn(), waitUntil: () => {},
      capabilities: { connections: { runtime: () => test.runtime } },
    }, {})).rejects.toMatchObject({ code: "ENV_BRIDGE_UNTRUSTED" })
    expect(test.requests).toHaveLength(1)
  }
  finally { test.close() }
})
