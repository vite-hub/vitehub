import { expect, it } from "vitest"

import { createVercelProvisionClient, isProvisionRequestError } from "../src/provision.ts"
import { mcpArgumentsInvalid, mcpMethodFailed, mcpMethodRpcCode } from "../src/runtime/mcp-server.ts"
import { internalErrorDiagnostics } from "../src/error-diagnostics.ts"

it("gives each MCP method code a fix, its own docs page, and its JSON-RPC code", () => {
  const errors = [mcpArgumentsInvalid("Missing name."), mcpMethodFailed("summary", new Error("boom")), internalErrorDiagnostics.INTERNAL_MCP_RESOURCE_NOT_FOUND({ uri: "skill://a" })]
  expect(errors.map(error => mcpMethodRpcCode(error))).toEqual([-32602, -32603, -32002])
  for (const error of errors) {
    const { code, docs, fix } = error as Error & { code: string, docs?: string, fix?: string }
    expect(fix).toMatch(/\S/)
    expect(docs).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  }
  expect(mcpMethodRpcCode(new Error("other"))).toBeUndefined()
})

it("rejects a failed provider call with INTERNAL_R0013, its kind, and its status", async () => {
  const request = createVercelProvisionClient({ token: "token" }, async () => Response.json({ error: { code: "forbidden" } }, { status: 403 }))
  const error = await request("/v1/storage/stores", { method: "POST" }).catch((caught: unknown) => caught)
  expect(isProvisionRequestError(error)).toBe(true)
  expect(error).toMatchObject({ code: "INTERNAL_R0013", status: 403 })
})
