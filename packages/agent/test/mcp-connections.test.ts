import { createAgentEnvIdentity } from "../src/internal/env-identity.ts"
import { expect, it, vi } from "vitest"

import { defineConnection } from "../../connections/src/definition.ts"
import { createConnectionsRuntime } from "../../connections/src/runtime.ts"
import { connect, createTestRuntime, mailConnection, testProvider } from "../../connections/test/helpers.ts"
import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { mcp } from "../src/capabilities/mcp.ts"

import type { ConnectionsRuntime } from "../../connections/src/runtime.ts"
import type { ConnectionOAuthDefinition } from "../../connections/src/types.ts"
import type { McpCapabilityOptions } from "../src/mcp/types.ts"

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

function mcpEndpointConnection(): ConnectionOAuthDefinition {
  // SAFETY: The helper narrows the typed Mail API to the runtime definition shape, like mailConnection().
  return defineConnection({
    access: { "agent:agent": { read: true, write: ["fetch"], approve: false } },
    provider: { ...testProvider(), mcp: "https://mcp.example.com/mcp" },
    scopes: ["mail.modify"],
  }) as ConnectionOAuthDefinition
}

function fakeMcpServer(test: ReturnType<typeof createTestRuntime>) {
  const urls: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === "https://auth.example.com/token") return test.provider.fetch(input, init)
    urls.push(String(input))
    if (init?.method !== "POST") return new Response(null, { status: 405 })
    const message = JSON.parse(String(init.body)) as { id?: number, method: string }
    if (message.id === undefined) return new Response(null, { status: 202 })
    const result = message.method === "initialize"
      ? { capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } }
      : { tools: ["search", "send"].map(name => ({ inputSchema: { type: "object", properties: {} }, name })) }
    return Response.json({ id: message.id, jsonrpc: "2.0", result })
  }
  return { fetch, urls }
}

function resolveWith(connections: ConnectionsRuntime, servers: McpCapabilityOptions["servers"]) {
  return resolveAgentCapabilities({ capabilities: [mcp({ servers })] }, {
    agentIdentity: createAgentEnvIdentity({ name: "agent" }),
    capabilities: { connections: { runtime: () => connections } },
    memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn(),
  }, {})
}

it("connects to the provider mcp endpoint and exposes only allowed tools", async () => {
  const definition = mcpEndpointConnection()
  const test = createTestRuntime(definition)
  const server = fakeMcpServer(test)
  const connections = createConnectionsRuntime({ definitions: { mail: definition }, fetch: server.fetch, store: test.store })
  await connect({ ...test, runtime: connections })

  const resolved = await resolveWith(connections, { mail: { connection: "mail", tools: ["search"] } })
  try {
    expect(Object.keys(resolved.tools ?? {})).toEqual(["mcp_mail_search"])
    expect(new Set(server.urls)).toEqual(new Set(["https://mcp.example.com/mcp"]))
  }
  finally { await resolved.close() }
})

it("skips an optional server until its Connection is connected", async () => {
  const definition = mcpEndpointConnection()
  const test = createTestRuntime(definition)
  const server = fakeMcpServer(test)
  const connections = createConnectionsRuntime({ definitions: { mail: definition }, fetch: server.fetch, store: test.store })

  const skipped = await resolveWith(connections, { mail: { connection: "mail", optional: true } })
  try {
    expect(skipped.tools?.mcp_mail_search).toBeUndefined()
    expect(server.urls).toEqual([])
  }
  finally { await skipped.close() }

  await connect({ ...test, runtime: connections })
  const resolved = await resolveWith(connections, { mail: { connection: "mail", optional: true } })
  try { expect(resolved.tools?.mcp_mail_search).toBeDefined() }
  finally { await resolved.close() }
})

it("fails clearly when the provider declares no mcp endpoint", async () => {
  const definition = mailConnection({ "agent:agent": { read: true, write: ["fetch"], approve: false } })
  const test = createTestRuntime(definition)
  await connect(test)
  await expect(resolveWith(test.runtime, { mail: { connection: "mail" } })).rejects.toThrow(/declares no mcp endpoint/)
})
