import { existsSync, readFileSync } from "node:fs"

import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createDirectoryDefinitionSource, discoverDefinitions, writeFileIfChanged, writeFileIfChangedSync } from "@vite-hub/internal/definition-catalog"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolve } from "pathe"

import { mcpErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubDefinitionSummary, ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, UserConfig } from "vite"
import type { McpOptions } from "./index.ts"

export type { McpOptions } from "./index.ts"

/** One tool file in `server/mcp/tools/`. */
export interface DiscoveredMcpTool {
  /** The absolute path of the file. */
  handler: string
  /** The tool name, which is the file path below `mcp/tools/` without the extension. */
  name: string
  source?: string
}

/** Options of {@link hubMcp}. `vite-hub` passes them from `vitehub({ mcp })`. */
export interface McpVitePluginOptions extends McpOptions {
  /** The name that MCP clients show. Defaults to the `name` of the app's `package.json`. */
  name?: string
  /** Import paths of the generated server entry. `vite-hub` passes its own subpaths. */
  imports?: {
    /** Defaults to `@vite-hub/auth/mcp`. */
    authMcp?: string
    /** Defaults to `@vite-hub/mcp/runtime`. */
    runtime?: string
  }
}

export type McpVitePlugin = Plugin & { vitehub: ViteHubInspectionPluginMetadata }

export const MCP_VITE_PLUGIN_NAME = "@vite-hub/mcp/vite"

const generatedDir = ".vitehub/nitro/mcp"
// MCP 2025-11-25 tool names: 1 to 128 characters of letters, digits, `_`, `-`, and `.`.
const toolName = /^[\w.-]{1,128}$/

/** Lists the tool files in `mcp/tools/` of each server directory. */
export function discoverMcpTools(options: { rootDir: string, serverDirs?: readonly string[] }): DiscoveredMcpTool[] {
  const serverDirs = options.serverDirs ? [...options.serverDirs] : [resolve(options.rootDir, "server")]
  const tools = discoverDefinitions<DiscoveredMcpTool>("MCP tool", [createDirectoryDefinitionSource("server-mcp-tools", serverDirs, "mcp/tools")])
  for (const tool of tools) {
    if (!toolName.test(tool.name)) {
      throw mcpErrorDiagnostics.MCP_B0002({ message: `[vitehub] ${relativeDefinitionFile(options.rootDir, tool.handler)} would be the MCP tool "${tool.name}". A tool name has 1 to 128 letters, digits, "_", "-", or ".". Rename the file, for example to "${tool.name.replace(/[^\w.-]+/g, "_").slice(0, 128)}.ts".` })
    }
  }
  return tools
}

function normalizeRoute(value: string, option: "publicRoute" | "route"): string {
  if (!/^\/[\w.~/-]*$/.test(value) || value.includes("//")) {
    throw mcpErrorDiagnostics.MCP_B0001({ message: `[vitehub] mcp.${option} must be a path such as "/mcp", without a query or "//". Got ${JSON.stringify(value)}.` })
  }
  return value.length > 1 ? value.replace(/\/+$/, "") : value
}

function packageName(projectRoot: string): string | undefined {
  const file = resolve(projectRoot, "package.json")
  if (!existsSync(file)) return undefined
  const name: unknown = JSON.parse(readFileSync(file, "utf8")).name
  return typeof name === "string" && name ? name : undefined
}

function renderHandler(tools: readonly DiscoveredMcpTool[], options: { auth: boolean, authMcp: string, name: string, only?: "public", route: string, runtime: string }): string {
  const entries = `{ ${tools.map((tool, index) => `${JSON.stringify(tool.name)}: tool${index}`).join(", ")} }`
  return [
    `import { createMcpHandler } from ${JSON.stringify(options.runtime)}`,
    ...options.auth ? [`import { verifyMcpRequest } from ${JSON.stringify(options.authMcp)}`] : [],
    ...tools.map((tool, index) => `import tool${index} from ${JSON.stringify(tool.handler)}`),
    "",
    "export default createMcpHandler({",
    `  name: ${JSON.stringify(options.name)},`,
    `  route: ${JSON.stringify(options.route)},`,
    options.only === "public"
      ? `  tools: Object.fromEntries(Object.entries(${entries}).filter(([, tool]) => tool.public === true)),`
      : `  tools: ${entries},`,
    ...options.auth ? ["  verify: request => verifyMcpRequest(request),"] : [],
    "})",
    "",
  ].join("\n")
}

function renderDiscovery(options: { authMcp: string, runtime: string }): string {
  return [
    `import { createMcpOAuthDiscoveryHandler } from ${JSON.stringify(options.runtime)}`,
    `import { serveMcpOAuthDiscovery } from ${JSON.stringify(options.authMcp)}`,
    "",
    "export default createMcpOAuthDiscoveryHandler(request => serveMcpOAuthDiscovery(request))",
    "",
  ].join("\n")
}

function isToolFile(file: string, serverDirs: readonly string[]): boolean {
  const normalized = file.replaceAll("\\", "/")
  return serverDirs.some(directory => normalized.startsWith(`${resolve(directory, "mcp/tools")}/`)) && /\.(?:c|m)?[jt]sx?$/i.test(normalized)
}

/**
 * The app MCP server: each file in `server/mcp/tools/` is one tool, and the server answers at `route` (`/mcp`). With
 * `auth`, every request needs an OAuth access token from `mcpOAuth()` of `vite-hub/auth/mcp`, and the server answers
 * the OAuth discovery documents at the origin root. `publicRoute` serves the tools with `public: true` to anyone.
 */
export function hubMcp(options: McpVitePluginOptions = {}): McpVitePlugin {
  const route = normalizeRoute(options.route ?? "/mcp", "route")
  const publicRoute = options.publicRoute === undefined ? undefined : normalizeRoute(options.publicRoute, "publicRoute")
  if (publicRoute === route) {
    throw mcpErrorDiagnostics.MCP_B0001({ message: `[vitehub] mcp.publicRoute must differ from mcp.route. Both are ${JSON.stringify(route)}.` })
  }
  const auth = options.auth === true
  const imports = { authMcp: options.imports?.authMcp ?? "@vite-hub/auth/mcp", runtime: options.imports?.runtime ?? "@vite-hub/mcp/runtime" }
  let projectRoot = process.cwd()
  let serverDirs: string[] = []
  let base = ""

  const handlerFile = () => resolve(projectRoot, generatedDir, "handler.ts")
  const publicHandlerFile = () => resolve(projectRoot, generatedDir, "public.ts")
  const name = () => options.name ?? packageName(projectRoot) ?? "app"
  const write = (writer: (file: string, contents: string) => unknown) => {
    const tools = discoverMcpTools({ rootDir: projectRoot, serverDirs })
    const written = [writer(handlerFile(), renderHandler(tools, { auth, ...imports, name: name(), route: `${base}${route}` }))]
    if (publicRoute) written.push(writer(publicHandlerFile(), renderHandler(tools, { auth: false, ...imports, name: name(), only: "public", route: `${base}${publicRoute}` })))
    return written
  }

  return {
    name: MCP_VITE_PLUGIN_NAME,
    enforce: "pre",
    vitehub: {
      inspect: () => ({
        definitions: [{
          kind: "mcp-tool",
          label: "MCP tools",
          list: (): ViteHubDefinitionSummary[] => discoverMcpTools({ rootDir: projectRoot, serverDirs }).map(tool => ({
            fields: [
              { label: "Route", value: `${base}${route}` },
              { label: "Auth", value: auth ? "OAuth (mcpOAuth)" : "public" },
              ...publicRoute ? [{ label: "Public route", value: `${base}${publicRoute} (tools with public: true)` }] : [],
            ],
            file: relativeDefinitionFile(projectRoot, tool.handler),
            name: tool.name,
            source: "server/mcp/tools",
          })),
        }],
      }),
    },
    config(config) {
      projectRoot = resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
      // SAFETY: ViteHub writes this string-array metadata through its shared Vite config contract.
      const configured = (config as UserConfig & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      serverDirs = configured ?? [resolve(projectRoot, "server")]
      const kit = createNitroServerKit((config as { nitro?: unknown }).nitro)
      base = typeof kit.config.baseURL === "string" ? kit.config.baseURL.replace(/\/+$/, "") : ""
      // Nitro reads the generated files when it starts, so they exist before its config hook runs.
      write(writeFileIfChangedSync)
      kit.addHandler({ handler: handlerFile(), route })
      if (publicRoute) kit.addHandler({ handler: publicHandlerFile(), route: publicRoute })
      if (auth) {
        const discoveryFile = resolve(projectRoot, generatedDir, "discovery.ts")
        writeFileIfChangedSync(discoveryFile, renderDiscovery(imports))
        // Route-less Nitro 3 middleware also runs outside baseURL, where OAuth discovery must be served.
        kit.addHandler({ handler: discoveryFile, middleware: true }, "start")
      }
      ;(config as { nitro?: unknown }).nitro = kit.config
    },
    configureServer(server) {
      // A new or removed tool file changes the imports of the server entry. Nitro reloads it from disk.
      const refresh = (file: string) => {
        if (!isToolFile(file, serverDirs)) return
        Promise.all(write(writeFileIfChanged)).catch(error => server.config.logger.error(String(error)))
      }
      server.watcher.on("add", refresh)
      server.watcher.on("unlink", refresh)
    },
  }
}
