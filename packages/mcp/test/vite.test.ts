import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it } from "vitest"

import { discoverMcpTools, hubMcp } from "../src/vite.ts"

import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"

const roots: string[] = []

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vitehub-mcp-"))
  roots.push(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-app" }))
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const tool = "export default { description: 'x', handler: () => 'x' }\n"

describe("MCP tool discovery", () => {
  it("names each tool after its file in server/mcp/tools", () => {
    const root = app({ "server/mcp/tools/list_drops.ts": tool, "server/mcp/tools/read_drop.ts": tool, "server/mcp/format.ts": tool })
    expect(discoverMcpTools({ rootDir: root }).map(entry => entry.name)).toEqual(["list_drops", "read_drop"])
  })

  it("preserves an explicit empty directory selection", () => {
    const root = app({ "server/mcp/tools/excluded.ts": tool })
    expect(discoverMcpTools({ rootDir: root, serverDirs: [] })).toEqual([])
  })

  it("fails the build for a file name that MCP does not allow", () => {
    const root = app({ "server/mcp/tools/admin/stats.ts": tool })
    expect(() => discoverMcpTools({ rootDir: root })).toThrow(expect.objectContaining({ name: "MCP_B0002" }))
  })
})

describe("hubMcp", () => {
  function configure(root: string, options: Parameters<typeof hubMcp>[0] = {}, host: object = {}) {
    const plugin = hubMcp(options)
    const config: { root: string, nitro?: { handlers?: unknown[] } } = { root, ...host }
    // SAFETY: The config hook is a plain function in this plugin.
    ;(plugin.config as (config: object) => void)(config)
    return { config, plugin }
  }

  it("serves the tools at /mcp and lists them for `vitehub inspect`", async () => {
    const root = app({ "server/mcp/tools/add.ts": tool })
    const { config, plugin } = configure(root)
    const handler = join(root, ".vitehub/nitro/mcp/handler.ts")
    expect(config.nitro?.handlers).toEqual([{ handler, route: "/mcp" }])
    const entry = readFileSync(handler, "utf8")
    expect(entry).toContain(`import tool0 from ${JSON.stringify(join(root, "server/mcp/tools/add.ts"))}`)
    expect(entry).toContain("name: \"fixture-app\"")
    expect(entry).not.toContain("verifyMcpRequest")

    const inspect = plugin.vitehub.inspect as () => ViteHubInspectionContributor
    const [inspector] = inspect().definitions ?? []
    expect(inspector?.kind).toBe("mcp-tool")
    expect(await inspector?.list()).toEqual([{
      fields: [{ label: "Route", value: "/mcp" }, { label: "Auth", value: "public" }],
      file: "server/mcp/tools/add.ts",
      name: "add",
      source: "server/mcp/tools",
    }])
  })

  it("checks the access token and answers OAuth discovery with auth", () => {
    const root = app({ "server/mcp/tools/add.ts": tool })
    const { config } = configure(root, { auth: true, route: "/api/mcp/" })
    expect(config.nitro?.handlers).toEqual([
      { handler: join(root, ".vitehub/nitro/mcp/discovery.ts"), middleware: true },
      { handler: join(root, ".vitehub/nitro/mcp/handler.ts"), route: "/api/mcp" },
    ])
    expect(readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")).toContain("verify: request => verifyMcpRequest(request)")
    expect(readFileSync(join(root, ".vitehub/nitro/mcp/discovery.ts"), "utf8")).toContain("serveMcpOAuthDiscovery")
  })

  it("does not import or inspect tools excluded by the host", async () => {
    const root = app({ "server/mcp/tools/excluded.ts": tool })
    const { plugin } = configure(root, {}, { [VITEHUB_SERVER_DIRS]: [] })
    expect(readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")).not.toContain("excluded")
    const inspect = plugin.vitehub.inspect as () => ViteHubInspectionContributor
    expect(await inspect().definitions?.[0]?.list()).toEqual([])
  })

  it("uses the mounted resource path and origin-wide discovery with a non-root Nitro base", () => {
    const root = app({ "server/mcp/tools/add.ts": tool })
    const { config } = configure(root, { auth: true }, { nitro: { baseURL: "/portal/" } })
    expect(config.nitro?.handlers).toEqual([
      { handler: join(root, ".vitehub/nitro/mcp/discovery.ts"), middleware: true },
      { handler: join(root, ".vitehub/nitro/mcp/handler.ts"), route: "/mcp" },
    ])
    expect(readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")).toContain('route: "/portal/mcp"')
  })

  it("serves the tools with public: true at publicRoute without sign-in", async () => {
    const root = app({ "server/mcp/tools/add.ts": tool })
    const { config, plugin } = configure(root, { auth: true, publicRoute: "/mcp/", route: "/mcp/account" }, { nitro: { baseURL: "/portal/" } })
    expect(config.nitro?.handlers).toEqual([
      { handler: join(root, ".vitehub/nitro/mcp/discovery.ts"), middleware: true },
      { handler: join(root, ".vitehub/nitro/mcp/handler.ts"), route: "/mcp/account" },
      { handler: join(root, ".vitehub/nitro/mcp/public.ts"), route: "/mcp" },
    ])
    expect(readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")).toContain("verify: request => verifyMcpRequest(request)")
    const entry = readFileSync(join(root, ".vitehub/nitro/mcp/public.ts"), "utf8")
    expect(entry).not.toContain("verifyMcpRequest")
    expect(entry).toContain('route: "/portal/mcp"')
    expect(entry).toContain("filter(([, tool]) => tool.public === true)")
    const inspect = plugin.vitehub.inspect as () => ViteHubInspectionContributor
    expect((await inspect().definitions?.[0]?.list())?.[0]?.fields).toContainEqual({ label: "Public route", value: "/portal/mcp (tools with public: true)" })
  })

  it("rejects a route that is not a path", () => {
    expect(() => hubMcp({ route: "mcp" })).toThrow(expect.objectContaining({ name: "MCP_B0001" }))
    expect(() => hubMcp({ publicRoute: "mcp" })).toThrow(expect.objectContaining({ name: "MCP_B0001" }))
    expect(() => hubMcp({ publicRoute: "/mcp/" })).toThrow(expect.objectContaining({ name: "MCP_B0001" }))
  })
})
