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

/** Lists the prompt files in `mcp/prompts/` or the resource files in `mcp/resources/` of each server directory. */
function discoverMcpFiles(kind: "prompts" | "resources", options: { rootDir: string, serverDirs?: readonly string[] }): DiscoveredMcpTool[] {
  const serverDirs = options.serverDirs ? [...options.serverDirs] : [resolve(options.rootDir, "server")]
  return discoverDefinitions<DiscoveredMcpTool>(kind === "prompts" ? "MCP prompt" : "MCP resource", [createDirectoryDefinitionSource(`server-mcp-${kind}`, serverDirs, `mcp/${kind}`)])
}

interface McpDefinitionFiles {
  tools: DiscoveredMcpTool[]
  prompts: DiscoveredMcpTool[]
  resources: DiscoveredMcpTool[]
}

function discoverAll(options: { rootDir: string, serverDirs: readonly string[] }): McpDefinitionFiles {
  return { tools: discoverMcpTools(options), prompts: discoverMcpFiles("prompts", options), resources: discoverMcpFiles("resources", options) }
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

interface RenderOptions extends Pick<McpOptions, "instructions" | "serverInfo"> {
  auth: boolean
  authMcp: string
  name: string
  only?: "public"
  publicRoute: string | undefined
  route: string
  runtime: string
}

function renderHandler(files: McpDefinitionFiles, options: RenderOptions): string {
  const field = (key: keyof McpDefinitionFiles, prefix: string) => {
    const entries = `{ ${files[key].map((file, index) => `${JSON.stringify(file.name)}: ${prefix}${index}`).join(", ")} }`
    return options.only === "public"
      ? `  ${key}: Object.fromEntries(Object.entries(${entries}).filter(([, ${prefix}]) => ${prefix}.public === true)),`
      : `  ${key}: ${entries},`
  }
  return [
    `import { createMcpHandler } from ${JSON.stringify(options.runtime)}`,
    ...options.auth ? [`import { verifyMcpRequest } from ${JSON.stringify(options.authMcp)}`] : [],
    ...files.tools.map((tool, index) => `import tool${index} from ${JSON.stringify(tool.handler)}`),
    ...files.prompts.map((prompt, index) => `import prompt${index} from ${JSON.stringify(prompt.handler)}`),
    ...files.resources.map((resource, index) => `import resource${index} from ${JSON.stringify(resource.handler)}`),
    "",
    "export default createMcpHandler({",
    `  name: ${JSON.stringify(options.name)},`,
    `  route: ${JSON.stringify(options.route)},`,
    ...options.publicRoute ? [`  publicRoute: ${JSON.stringify(options.publicRoute)},`] : [],
    ...options.instructions === undefined ? [] : [`  instructions: ${JSON.stringify(options.instructions)},`],
    ...options.serverInfo === undefined ? [] : [`  serverInfo: ${JSON.stringify(options.serverInfo)},`],
    field("tools", "tool"),
    ...files.prompts.length ? [field("prompts", "prompt")] : [],
    ...files.resources.length ? [field("resources", "resource")] : [],
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

function isDefinitionFile(file: string, serverDirs: readonly string[]): boolean {
  const normalized = file.replaceAll("\\", "/")
  return serverDirs.some(directory => ["tools", "prompts", "resources"].some(kind => normalized.startsWith(`${resolve(directory, "mcp", kind)}/`)))
    && /\.(?:c|m)?[jt]sx?$/i.test(normalized)
}

/**
 * The app MCP server: each file in `server/mcp/tools/` is one tool, each file in `server/mcp/prompts/` one prompt, and
 * each file in `server/mcp/resources/` one resource. The server answers at `route` (`/mcp`). By default,
 * every request needs an OAuth access token from `mcpOAuth()` of `vite-hub/auth/mcp`, and the server answers
 * the OAuth discovery documents at the origin root. `auth: false` makes every definition public. `publicRoute` serves the tools with `public: true` to anyone.
 */
export function hubMcp(options: McpVitePluginOptions = {}): McpVitePlugin {
  const route = normalizeRoute(options.route ?? "/mcp", "route")
  const publicRoute = options.publicRoute === undefined ? undefined : normalizeRoute(options.publicRoute, "publicRoute")
  if (publicRoute === route) {
    throw mcpErrorDiagnostics.MCP_B0001({ message: `[vitehub] mcp.publicRoute must differ from mcp.route. Both are ${JSON.stringify(route)}.` })
  }
  const auth = options.auth !== false
  if (publicRoute && !auth) {
    throw mcpErrorDiagnostics.MCP_B0003({ message: `[vitehub] mcp.publicRoute needs auth. With mcp: { auth: false }, every tool on ${JSON.stringify(route)} is public already.` })
  }
  const imports = { authMcp: options.imports?.authMcp ?? "@vite-hub/auth/mcp", runtime: options.imports?.runtime ?? "@vite-hub/mcp/runtime" }
  let projectRoot = process.cwd()
  let serverDirs: string[] = []
  let base = ""

  const handlerFile = () => resolve(projectRoot, generatedDir, "handler.ts")
  const publicHandlerFile = () => resolve(projectRoot, generatedDir, "public.ts")
  const name = () => options.name ?? packageName(projectRoot) ?? "app"
  const server = { instructions: options.instructions, serverInfo: options.serverInfo }
  const write = (writer: (file: string, contents: string) => unknown) => {
    const files = discoverAll({ rootDir: projectRoot, serverDirs })
    const publicPath = publicRoute ? `${base}${publicRoute}` : undefined
    const written = [writer(handlerFile(), renderHandler(files, { auth, ...imports, ...server, publicRoute: publicPath, name: name(), route: `${base}${route}` }))]
    if (publicRoute) written.push(writer(publicHandlerFile(), renderHandler(files, { auth: false, ...imports, ...server, publicRoute: publicPath, name: name(), only: "public", route: `${base}${publicRoute}` })))
    return written
  }
  const fields = (kind: "prompts" | "resources" | "tools") => [
    { label: "Route", value: `${base}${route}` },
    { label: "Auth", value: auth ? "OAuth (mcpOAuth)" : "public" },
    ...publicRoute ? [{ label: "Public route", value: `${base}${publicRoute} (${kind} with public: true)` }] : [],
  ]
  const inspector = (kind: "prompts" | "resources") => ({
    kind: kind === "prompts" ? "mcp-prompt" : "mcp-resource",
    label: kind === "prompts" ? "MCP prompts" : "MCP resources",
    list: (): ViteHubDefinitionSummary[] => discoverMcpFiles(kind, { rootDir: projectRoot, serverDirs }).map(file => ({
      fields: fields(kind),
      file: relativeDefinitionFile(projectRoot, file.handler),
      name: file.name,
      source: `server/mcp/${kind}`,
    })),
  })

  return {
    name: MCP_VITE_PLUGIN_NAME,
    enforce: "pre",
    vitehub: {
      inspect: () => ({
        definitions: [{
          kind: "mcp-tool",
          label: "MCP tools",
          list: (): ViteHubDefinitionSummary[] => discoverMcpTools({ rootDir: projectRoot, serverDirs }).map(tool => ({
            fields: fields("tools"),
            file: relativeDefinitionFile(projectRoot, tool.handler),
            name: tool.name,
            source: "server/mcp/tools",
          })),
        }, inspector("prompts"), inspector("resources")],
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
      // A new or removed tool, prompt, or resource file changes the imports of the server entry. Nitro reloads it from disk.
      const refresh = (file: string) => {
        if (!isDefinitionFile(file, serverDirs)) return
        Promise.all(write(writeFileIfChanged)).catch(error => server.config.logger.error(String(error)))
      }
      server.watcher.on("add", refresh)
      server.watcher.on("unlink", refresh)
    },
  }
}
