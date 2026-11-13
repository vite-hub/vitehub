import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import ts from "typescript"
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

  it("serves prompts and resources, the configured server info, and lists them for `vitehub inspect`", async () => {
    const root = app({
      "server/mcp/prompts/review.ts": tool,
      "server/mcp/resources/changelog.ts": tool,
      "server/mcp/tools/add.ts": tool,
    })
    const serverInfo = { icons: [{ src: "/favicon.svg" }], title: "Drop" }
    const { plugin } = configure(root, { instructions: "Read the skill first.", publicRoute: "/mcp/public", serverInfo })
    const entry = readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")
    expect(entry).toContain(`import prompt0 from ${JSON.stringify(join(root, "server/mcp/prompts/review.ts"))}`)
    expect(entry).toContain(`import resource0 from ${JSON.stringify(join(root, "server/mcp/resources/changelog.ts"))}`)
    expect(entry).toContain("  prompts: { \"review\": prompt0 },")
    expect(entry).toContain("  resources: { \"changelog\": resource0 },")
    expect(entry).toContain("  instructions: \"Read the skill first.\",")
    expect(entry).toContain(`  serverInfo: ${JSON.stringify(serverInfo)},`)
    expect(readFileSync(join(root, ".vitehub/nitro/mcp/public.ts"), "utf8")).toContain("filter(([, prompt]) => prompt.public === true)")

    const inspect = plugin.vitehub.inspect as () => ViteHubInspectionContributor
    const inspectors = inspect().definitions ?? []
    expect(inspectors.map(inspector => inspector.kind)).toEqual(["mcp-tool", "mcp-prompt", "mcp-resource"])
    expect((await inspectors[1]?.list())?.map(entry => [entry.name, entry.file, entry.source])).toEqual([["review", "server/mcp/prompts/review.ts", "server/mcp/prompts"]])
    expect((await inspectors[2]?.list())?.[0]?.fields).toContainEqual({ label: "Public route", value: "/mcp/public (resources with public: true)" })
  })

  it("passes the hooks of server/mcp.ts and types caller with what resolveCaller returns", () => {
    const root = app({
      "server/mcp.ts": "import { defineMcpHooks } from \"@vite-hub/mcp\"\n\nexport default defineMcpHooks({ resolveCaller: () => ({ teamId: \"t1\" }) })\n",
      "server/mcp/tools/team.ts": [
        "import { defineMcpTool } from \"@vite-hub/mcp\"",
        "",
        "export default defineMcpTool({ description: \"Team.\", handler: (_input, { caller }) => caller.teamId })",
        "// @ts-expect-error The caller is the app identity, not the OAuth caller.",
        "export const user = defineMcpTool({ description: \"User.\", handler: (_input, { caller }) => caller.user })",
        "",
      ].join("\n"),
    })
    configure(root)
    const entry = readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")
    expect(entry).toContain(`import hooks from ${JSON.stringify(join(root, "server/mcp.ts"))}`)
    expect(entry).toContain("  hooks,")

    mkdirSync(join(root, "node_modules/@vite-hub"), { recursive: true })
    symlinkSync(join(import.meta.dirname, ".."), join(root, "node_modules/@vite-hub/mcp"), "dir")
    const program = ts.createProgram([join(root, ".vitehub/types/mcp.d.ts"), join(root, "server/mcp/tools/team.ts")], {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    })
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  })

  it("writes no caller type without server/mcp.ts, and allows one hooks module", () => {
    const root = app({ "server/mcp/tools/add.ts": tool })
    configure(root)
    expect(readFileSync(join(root, ".vitehub/types/mcp.d.ts"), "utf8")).toBe("export {}\n")
    expect(readFileSync(join(root, ".vitehub/nitro/mcp/handler.ts"), "utf8")).not.toContain("hooks")

    const twice = app({ "app/mcp.ts": tool, "server/mcp.ts": tool })
    expect(() => configure(twice, {}, { [VITEHUB_SERVER_DIRS]: [join(twice, "server"), join(twice, "app")] })).toThrow(expect.objectContaining({ name: "MCP_B0003" }))
  })

  it("rejects a route that is not a path", () => {
    expect(() => hubMcp({ route: "mcp" })).toThrow(expect.objectContaining({ name: "MCP_B0001" }))
    expect(() => hubMcp({ publicRoute: "mcp" })).toThrow(expect.objectContaining({ name: "MCP_B0001" }))
    expect(() => hubMcp({ publicRoute: "/mcp/" })).toThrow(expect.objectContaining({ name: "MCP_B0001" }))
  })
})
