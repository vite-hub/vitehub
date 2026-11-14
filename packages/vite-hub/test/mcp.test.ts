import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { vitehub, type ViteHubOptions } from "../src/index.ts"

import type { Plugin } from "vite"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function mcpPlugin(options: ViteHubOptions): Plugin | undefined {
  // SAFETY: vitehub() returns concrete plugins, and the included Nitro plugins as one nested list.
  return (vitehub(options).flat() as Plugin[]).find(plugin => plugin.name === "@vite-hub/mcp/vite")
}

/** The server entry that the plugin generates for an app with one tool. */
function generatedEntry(plugin: Plugin): string {
  const root = mkdtempSync(join(tmpdir(), "vitehub-mcp-app-"))
  roots.push(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }))
  mkdirSync(join(root, "server/mcp/tools"), { recursive: true })
  writeFileSync(join(root, "server/mcp/tools/add.ts"), "export default {}\n")
  // SAFETY: The MCP plugin's config hook is a plain function.
  ;(plugin.config as (config: object) => void)({ root })
  return readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")
}

describe("vitehub({ mcp })", () => {
  it("adds the MCP server only when mcp is on", () => {
    expect(mcpPlugin({ host: "node" })).toBeUndefined()
    expect(mcpPlugin({ auth: true, host: "node", mcp: true })).toBeDefined()
  })

  it("checks MCP OAuth tokens unless mcp.auth is false", () => {
    const protectedEntry = generatedEntry(mcpPlugin({ auth: true, mcp: true, host: "node" })!)
    expect(protectedEntry).toContain("import { verifyMcpRequest } from \"vite-hub/auth/mcp\"")
    expect(protectedEntry).toContain("import { createMcpHandler } from \"@vite-hub/mcp/runtime\"")
    expect(generatedEntry(mcpPlugin({ auth: true, mcp: { auth: false }, host: "node" })!)).not.toContain("verifyMcpRequest")
    expect(generatedEntry(mcpPlugin({ mcp: { auth: false }, host: "node" })!)).not.toContain("verifyMcpRequest")
  })

  it("fails when the MCP server would be public without an explicit mcp.auth: false", () => {
    expect(() => vitehub({ mcp: true, host: "node" })).toThrow(expect.objectContaining({ name: "VITE_HUB_R0141" }))
    expect(() => vitehub({ mcp: {}, host: "node" })).toThrow(expect.objectContaining({ name: "VITE_HUB_R0141" }))
    expect(() => vitehub({ mcp: { auth: true }, host: "node" })).toThrow(expect.objectContaining({ name: "VITE_HUB_R0141" }))
  })
})
