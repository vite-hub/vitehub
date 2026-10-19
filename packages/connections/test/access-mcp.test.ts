import { describe, expect, it } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"

import { defineConnection } from "../src/definition.ts"
import { connect, createTestRuntime, testProvider } from "./helpers.ts"

import type { MailApi } from "./helpers.ts"
import type { ConnectionAccessPreset, ConnectionAccessRule, ConnectionActionPattern, ConnectionOAuthDefinition } from "../src/types.ts"

const MCP = "https://mail.example.com/mcp"

function mcpConnection(access: Record<string, ConnectionAccessRule<ConnectionActionPattern<{ mail: MailApi }>> | ConnectionAccessPreset>): ConnectionOAuthDefinition {
  return defineConnection({
    access,
    api: { mail: ["labels.*", "messages.modify"] },
    provider: { ...testProvider(), mcp: MCP },
    scopes: ["mail.modify"],
  }) as ConnectionOAuthDefinition
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the call to fail.")
}

describe("the mcp access preset", () => {
  it("allows every method on the mcp endpoint without an approval", async () => {
    const test = createTestRuntime(mcpConnection({ "agent:bot": "mcp" }))
    await connect(test)
    const client = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot" }) })
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await client.fetch(`${MCP}/`, { method, ...(method === "POST" ? { body: "{}" } : {}) })
      expect(response.status).toBe(200)
      expect(test.provider.calls.at(-1)).toMatchObject({ method, url: `${MCP}/` })
    }
    expect((await test.runtime.approvals({ status: "pending" })).approvals).toEqual([])
  })

  it("denies every request that is not for the mcp endpoint", async () => {
    const test = createTestRuntime(mcpConnection({ "agent:bot": "mcp" }))
    await connect(test)
    const calls = test.provider.calls.length
    const client = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot" }) })
    expect(await rejection(client.call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    expect(await rejection(client.call("mail.messages.modify", { id: "m1", userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    expect(await rejection(client.fetch("https://mail.example.com/mail/v1/users/me/labels"))).toMatchObject({ code: "CONNECTION_DENIED" })
    expect(await rejection(client.fetch("https://mail.example.com/mcp-admin", { body: "{}", method: "POST" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    expect(test.provider.calls).toHaveLength(calls)
  })

  it("follows extends and applies only to the actor that it names", async () => {
    const test = createTestRuntime(mcpConnection({ "agent:bot": "mcp", "server": { read: true } }))
    await connect(test)
    const child = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot-dev" }, {}, ["bot"]) })
    expect((await child.fetch(MCP, { body: "{}", method: "POST" })).status).toBe(200)
    const server = test.runtime.client("mail", {})
    expect(await rejection(server.fetch(MCP, { body: "{}", method: "POST" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    await expect(server.call("mail.labels.list", { userId: "me" })).resolves.toBeDefined()
  })

  it("requires a provider mcp endpoint", () => {
    expect(() => defineConnection({ access: { "agent:bot": "mcp" }, provider: testProvider(), scopes: [] })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    // SAFETY: The test checks that runtime validation rejects an unknown preset name.
    const unknown = { "agent:bot": "all" } as unknown as Record<string, ConnectionAccessPreset>
    expect(() => defineConnection({ access: unknown, provider: { ...testProvider(), mcp: MCP }, scopes: [] })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
  })
})
