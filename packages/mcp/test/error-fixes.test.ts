import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, it } from "vitest"

import { mcpErrorDiagnostics } from "../src/error-diagnostics.ts"
import { discoverMcpTools, hubMcp } from "../src/vite.ts"

const fixedCodes = ["MCP_B0001", "MCP_B0002"] as const
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

it("gives each MCP build code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = mcpErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/mcp/diagnostics/${code.toLowerCase()}`)
  }
})

it("names the route options when the public route is the same as the route", () => {
  expect(() => hubMcp({ publicRoute: "/mcp", route: "/mcp" })).toThrow(expect.objectContaining({
    code: "MCP_B0001",
    fix: expect.stringContaining("`mcp.publicRoute`"),
  }))
})

it("names server/mcp/tools/ when a tool file has a name that MCP does not allow", () => {
  const root = mkdtempSync(join(tmpdir(), "vitehub-mcp-error-fixes-"))
  roots.push(root)
  mkdirSync(join(root, "server/mcp/tools"), { recursive: true })
  writeFileSync(join(root, "server/mcp/tools/read drop.ts"), "export default {}\n")

  expect(() => discoverMcpTools({ rootDir: root })).toThrow(expect.objectContaining({
    code: "MCP_B0002",
    fix: expect.stringContaining("`server/mcp/tools/`"),
  }))
})
