import { createAgentEnvIdentity } from "../src/internal/env-identity.ts"
import { expect, it, vi } from "vitest"

import { createConnectionsRuntime } from "../../connections/src/runtime.ts"
import { connect, createTestRuntime, mailConnection } from "../../connections/test/helpers.ts"
import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { mcp } from "../src/capabilities/mcp.ts"

it.each([undefined, true, false])("discovers MCP tools only with immediate Connection access: %s", async (approve) => {
  const definition = mailConnection({ "agent:agent": { read: true, write: ["fetch"], approve } })
  const test = createTestRuntime(definition)
  const methods: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === "https://auth.example.com/token") return test.provider.fetch(input, init)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token-secret-1")
    if (init?.method !== "POST") return new Response(null, { status: 405 })
    const message = JSON.parse(String(init.body)) as { id?: number, method: string }
    methods.push(message.method)
    if (message.id === undefined) return new Response(null, { status: 202 })
    const result = message.method === "initialize"
      ? { capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } }
      : { tools: [{ inputSchema: { type: "object", properties: {} }, name: "search" }] }
    return Response.json({ id: message.id, jsonrpc: "2.0", result })
  }
  const connections = createConnectionsRuntime({ definitions: { mail: definition }, fetch, store: test.store })
  await connect({ ...test, runtime: connections })
  const resolve = () => resolveAgentCapabilities({
    capabilities: [mcp({ servers: { mail: { connection: "mail", transport: { type: "http", url: "https://mail.example.com/mcp" } } } })],
  }, {
    agentIdentity: createAgentEnvIdentity({ name: "agent" }),
    capabilities: { connections: { runtime: () => connections } },
    memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn(),
  }, {})
  if (approve === false) {
    const resolved = await resolve()
    try {
      expect(resolved.tools?.mcp_mail_search).toBeDefined()
      expect(methods).toContain("initialize")
      expect(methods).toContain("tools/list")
    }
    finally { await resolved.close() }
  }
  else {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(resolve()).rejects.toThrow(/immediate access|approve: false/)
    }
    expect(methods).toEqual([])
  }
  expect((await connections.approvals({ status: "pending" })).approvals).toEqual([])
})
