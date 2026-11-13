import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { ConsoleBuildCatalog } from "./build.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

import { createConsoleInvocationsIdentity } from "./internal.ts"
import { resolveConsoleProjectNameFromRoot } from "./project.ts"
import { describeConsoleContributedSections, describeConsoleDocumentEditors, describeConsoleRuntimeReaders } from "./contributions.ts"
import { withConsoleDocumentEditorSections } from "./build.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { requireOptionalOwner } from "../internal/optional-owners.ts"
import { generatedModules } from "../internal/generated-modules.ts"
import { ownerModules } from "../internal/owner-modules.ts"
import { setupDevRoute } from "../setup-dev.ts"

function resolveConsoleRuntimeRoot(): string {
  const root = [
    fileURLToPath(new URL("./runtime", import.meta.url)),
    fileURLToPath(new URL("./console/runtime", import.meta.url)),
  ].find(root => ["rpc.ts", "rpc.js"].some(file => existsSync(join(root, "server", file))))
  if (!root) throw viteHubErrorDiagnostics.VITE_HUB_B0001({ message: "[vitehub] Could not locate the packaged Console runtime." })
  return root
}
export const consoleRuntimeRoot: string = resolveConsoleRuntimeRoot()
/** The ViteHub skill and its well-known index, which the Console serves at `/_vitehub/.well-known/skills`. */
export const consoleSkillsRoot: string = join(consoleRuntimeRoot, "public/skills")

/**
 * The Console access policy that generated output installs. The Console route checks it.
 * - `token`: only requests that the ViteHub Console or the CLI signed. The default.
 * - `open`: `console: { auth: false }`, development only.
 * - `local`: `vite dev` without Console options. Production requests fail closed.
 * `authorize` is the `console.authorize` server file.
 */
export interface ConsoleAccessBuild {
  mode: "open" | "local" | "token"
  authorize?: string
  /** `console.impersonation`. */
  impersonation?: true
  /** `console.sections`: the sections that the app leaves out of its Console. */
  hiddenSections?: readonly ConsoleSectionId[]
}

interface ConsoleRuntimeCapabilityImport {
  exportName: string
  name: string
}

const consoleRuntimeCapabilityImports: readonly ConsoleRuntimeCapabilityImport[] = [
  { exportName: "blob", name: "blob" },
  { exportName: "connections", name: "connections" },
  { exportName: "content", name: "content" },
  { exportName: "agentConsole", name: "console" },
  { exportName: "agentDb", name: "db" },
  { exportName: "email", name: "email" },
  { exportName: "agentI18n", name: "i18n" },
  { exportName: "kv", name: "kv" },
]

/** The Agent capabilities of a Console invocation. They load with the first invocation, not when the server starts. */
function renderConsoleRuntimeCapabilities(imports: Record<string, false | string> | undefined): string | undefined {
  if (!imports) return undefined
  const capabilities = consoleRuntimeCapabilityImports.flatMap(({ exportName, name }) => {
    const module = imports[name]
    if (!module) return []
    const alias = `vitehubConsoleAgent${name[0]!.toUpperCase()}${name.slice(1)}`
    return [{ alias, exportName, module, name }]
  })
  if (!capabilities.length) return undefined
  const bindings = capabilities.map(({ alias, exportName }) => `{ ${exportName}: ${alias} }`).join(", ")
  const modules = capabilities.map(({ module }) => `import(${JSON.stringify(module)})`).join(", ")
  return `capabilities: async () => { const [${bindings}] = await Promise.all([${modules}]); return { ${capabilities.map(({ alias, name }) => `${name}: ${alias}`).join(", ")} } }`
}

function renderConsoleAccess(access: ConsoleAccessBuild | undefined): { imports: string[], install: string[] } {
  if (!access) return { imports: [], install: [] }
  const imports: string[] = []
  const fields = [`mode: ${JSON.stringify(access.mode)}`]
  if (access.authorize) {
    imports.push(`import vitehubConsoleAuthorize from ${JSON.stringify(pathToFileURL(access.authorize).href)}`)
    fields.push("authorize: vitehubConsoleAuthorize")
  }
  if (access.impersonation) fields.push("impersonation: true")
  return { imports, install: [`installConsoleAccess({ ${fields.join(", ")} })`] }
}

/** What the generated Console Nitro plugin installs. The Nuxt module and the Vite plugin both write it with these options. */
export interface ConsoleNitroPluginOptions {
  /** The generated plugin file. */
  file: string
  projectRoot: string
  sections: readonly ConsoleSectionId[]
  /** Visible navigation, when it differs from the sections whose operations need runtime state. */
  navigationSections?: readonly ConsoleSectionId[]
  /** The discovered Agents, Schedules, operations, and section content. */
  catalog: ConsoleBuildCatalog
  blobStores: readonly string[]
  /** Let the Console start Agent Invocations and run manual Schedules. */
  invoke?: boolean
  /** Write nothing when this returns `false`, such as after the dev server closed. */
  active?: () => boolean
  access?: ConsoleAccessBuild
  runtimeCapabilityImports?: Record<string, false | string>
  development?: boolean
  /**
   * Add the **Console** link to the page tools pill. `base` is the app base, such as `/portal/`. Leave it out for the
   * development RPC without Console options.
   */
  pageTool?: { base: string }
}

/** The URL of the Console page tool script below the app base. Its version query changes when the script changes. */
export const consolePageToolScript = "/_vitehub/console/assets/page-tool.js?v=1"

function renderConsolePageTool(pageTool: ConsoleNitroPluginOptions["pageTool"], auth: boolean): string {
  if (!pageTool) return "export default function viteHubConsolePlugin() {}"
  const user = auth ? `, user: async request => (await import(${JSON.stringify(generatedModules.consolePageAuth)})).consolePageAuthUser(request)` : ""
  return `export default function viteHubConsolePlugin(nitroApp) { installConsolePageTool(nitroApp, { base: ${JSON.stringify(pageTool.base)}, script: ${JSON.stringify(consolePageToolScript)}${user} }) }`
}

function renderConsoleNitroPlugin(
  {
    projectRoot,
    sections: configuredSections,
    navigationSections,
    catalog,
    blobStores,
    invoke = false,
    access,
    runtimeCapabilityImports,
    development = false,
    pageTool,
  }: ConsoleNitroPluginOptions,
): string {
  const agents = catalog.agents
  const accessCode = renderConsoleAccess(access)
  const operations = catalog.operations ?? []
  // The page tools pill comes with Site access: the browsers and guests that use it without an app sign-in.
  const sections = withConsoleDocumentEditorSections(pageTool ? [...configuredSections, "site"] : configuredSections, catalog)
    .filter(section => !access?.hiddenSections?.includes(section))
  const documentEditors = describeConsoleDocumentEditors(sections, catalog.documents ?? {})
  const runtimeCapabilities = renderConsoleRuntimeCapabilities(runtimeCapabilityImports)
  const agentSkills = agents.map(agent => requireOptionalOwner(ownerModules.agentVite, "agent").readColocatedAgentSkills(agent.handler))
  const definitions = agents.map((agent, index) => {
    const skills = agentSkills[index]
    const module = `vitehubConsoleAgent${index}`
    const definition = skills
      ? `agentWithColocatedSkills(${module}.default ?? ${module}, ${JSON.stringify(skills)})`
      : module
    return `{ definition: ${definition}, fallbackName: ${JSON.stringify(agent.name)} }`
  }).join(", ")
  const agentsEnabled = sections.includes("agents")
  const blobEnabled = sections.includes("blob")
  const databaseEnabled = sections.includes("databases")
  const mcpClientEnabled = sections.includes("mcp-client")
  const schedulesEnabled = sections.includes("schedules")
  const runnableSchedules = (invoke ? catalog.manualSchedules ?? [] : [])
    .map(schedule => ` [${JSON.stringify(schedule.name)}]: () => import(${JSON.stringify(pathToFileURL(schedule.handler).href)}),`)
    .join("")
    .replace(/,$/, " ")
  // An override also adds a section that no owner registers, such as Forms.
  const registered = new Map(describeConsoleContributedSections(sections).map(section => [section.id, section]))
  const contributedSections = sections.flatMap((id) => {
    const section = catalog.sectionOverrides?.[id] ?? registered.get(id)
    return section ? [section] : []
  })
  const runtimeReaders = describeConsoleRuntimeReaders(sections).filter(reader => catalog.sectionOverrides?.[reader.section]?.view.kind !== "operation-view")
  const definitionsEnabled = databaseEnabled || contributedSections.length > 0
  const runtimeImports = [
    { bindings: "installConsoleOperations", module: generatedModules.consoleOperations },
    ...operations.map((operation, index) => ({ bindings: `${operation.export}: vitehubConsoleOperations${index}`, module: operation.module })),
    // The MCP client SDK loads only for apps that turn the section on.
    ...(mcpClientEnabled ? [{ bindings: "consoleMcpClientOperations: vitehubConsoleMcpClientOperations", module: "vite-hub/console/mcp-client" }] : []),
    ...(blobEnabled ? [{ bindings: "installConsoleBlob", module: generatedModules.consoleBlob }, { bindings: "blob: vitehubConsoleBlob", module: "vite-hub/blob" }] : []),
    ...(definitionsEnabled ? [{ bindings: `installConsoleDefinitions${schedulesEnabled ? ", installConsoleSchedules" : ""}`, module: generatedModules.consoleDefinitions }] : []),
    ...(definitionsEnabled ? runtimeReaders.map((reader, index) => ({ bindings: `${reader.export}: vitehubConsoleRuntimeReader${index}`, module: reader.module })) : []),
    ...(databaseEnabled ? [{ bindings: "installConsoleDatabase", module: generatedModules.consoleDatabase }, { bindings: "databases: vitehubConsoleDatabases", module: "@vite-hub/database/runtime/registry" }] : []),
    ...(sections.includes("env") ? [{ bindings: "describeServerEnv", module: "#vitehub/env/description" }, { bindings: "installConsoleEnv", module: generatedModules.consoleEnv }] : []),
    // Agent Definitions import the Agent runtime, so they load with the Console runtime and not when the server starts.
    // `defineAgent()` of vite-hub/agent resolves the app-wide journal by itself, and the Agent registry names discovered Agents.
    ...(agentsEnabled ? [{ bindings: "installConsoleAgentDefinitions", module: "vite-hub/console/server" }] : []),
    ...(agentsEnabled && agentSkills.some(Boolean) ? [{ bindings: "agentWithColocatedSkills", module: requireOptionalOwner(ownerModules.agentVite, "agent").agentRuntimeModule("runtime/workflow") }] : []),
  ]
  const agentModules = agentsEnabled ? agents.map((agent, index) => ({ binding: `vitehubConsoleAgent${index}`, module: pathToFileURL(agent.handler).href })) : []
  const runtimeInstall = [
    ...(blobEnabled ? [`installConsoleBlob(${JSON.stringify(projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(blobStores)})`] : []),
    ...(sections.includes("env") ? [`installConsoleEnv(${JSON.stringify(projectRoot)}, describeServerEnv(), async () => (await import("#vitehub/env/server")).inspectServerEnv())`] : []),
    `installConsoleOperations([${[...(mcpClientEnabled ? ["{ operations: vitehubConsoleMcpClientOperations, plugin: \"vite-hub\" }"] : []), ...operations.map((operation, index) => `{ operations: vitehubConsoleOperations${index}, plugin: ${JSON.stringify(operation.plugin)} }`)].join(", ")}], { invoke: ${invoke} })`,
    ...(definitionsEnabled ? [`installConsoleDefinitions(${JSON.stringify(projectRoot)}, ${JSON.stringify(catalog.content)}, ${JSON.stringify(contributedSections)}${runtimeReaders.length ? `, { ${runtimeReaders.map((reader, index) => `${JSON.stringify(reader.section)}: vitehubConsoleRuntimeReader${index}`).join(", ")} }` : ""})`] : []),
    ...(schedulesEnabled ? [`installConsoleSchedules(${JSON.stringify(projectRoot)}, {${runnableSchedules}})`] : []),
    ...(databaseEnabled ? [`installConsoleDatabase(${JSON.stringify(projectRoot)}, vitehubConsoleDatabases, ${JSON.stringify(catalog.content.databases?.kind === "definition-catalog" ? catalog.content.databases.definitions.map(definition => definition.name) : [])})`] : []),
    ...(agentsEnabled
      ? [`installConsoleAgentDefinitions([${definitions}], { projectRoot: ${JSON.stringify(projectRoot)}${invoke ? ", invoke: true" : ""}${runtimeCapabilities ? `, ${runtimeCapabilities}` : ""} })`]
      : []),
  ]
  return [
    `import { ${access ? "installConsoleAccess, " : ""}installConsoleDevelopment, installConsoleProjectName, installConsoleRuntime, installConsoleSections } from ${JSON.stringify(generatedModules.consoleSetup)}`,
    ...accessCode.imports,
    // The page tools wrap the app's `fetch` when the server starts, so this one loads at startup.
    ...(pageTool ? [`import { installConsolePageTool } from ${JSON.stringify(generatedModules.consolePageTool)}`] : []),
    ...(documentEditors.length ? [`import { installConsoleDocuments } from ${JSON.stringify(generatedModules.consoleDocuments)}`] : []),
    ...documentEditors.map((editor, index) => `import { ${editor.export} as vitehubConsoleDocumentActions${index} } from ${JSON.stringify(editor.module)}`),
    `installConsoleDevelopment(${JSON.stringify(projectRoot)}, ${JSON.stringify(development)}${development && sections.includes("setup") ? `, ${JSON.stringify(setupDevRoute)}` : ""})`,
    ...accessCode.install,
    `installConsoleSections(${JSON.stringify(projectRoot)}, ${JSON.stringify(sections)}${navigationSections ? `, ${JSON.stringify(navigationSections)}` : ""})`,
    // The first Console request or agent tool that needs the operations loads them, with every primitive they import.
    `installConsoleRuntime(async () => {`,
    `  const [${[...runtimeImports.map(entry => `{ ${entry.bindings} }`), ...agentModules.map(entry => entry.binding)].join(", ")}] = await Promise.all([${[...runtimeImports, ...agentModules].map(entry => `import(${JSON.stringify(entry.module)})`).join(", ")}])`,
    "  return () => {",
    ...runtimeInstall.map(line => `    ${line}`),
    "  }",
    "})",
    `installConsoleProjectName(${JSON.stringify(projectRoot)}, ${JSON.stringify(resolveConsoleProjectNameFromRoot(projectRoot))})`,
    // The application module loads on the first document request, so the Console does not start Content at boot.
    ...(documentEditors.length
      ? [`installConsoleDocuments(${JSON.stringify(projectRoot)}, { ${documentEditors.map((editor, index) => `${JSON.stringify(editor.section)}: { actions: vitehubConsoleDocumentActions${index}, load: () => import(${JSON.stringify(pathToFileURL(editor.entry).href)}) }`).join(", ")} })`]
      : []),
    // The Auth reader of the Console page tool loads with the first page tools session.
    renderConsolePageTool(pageTool, configuredSections.includes("auth")),
    "",
  ].join("\n")
}

/** Write the generated Console Nitro plugin and return the invocation journal identity of the project. */
export async function writeConsoleNitroPlugin(options: ConsoleNitroPluginOptions): Promise<string> {
  const { file, projectRoot, active = () => true } = options
  const identity = createConsoleInvocationsIdentity(projectRoot)
  if (!active()) return identity
  const contents = renderConsoleNitroPlugin(options)
  if (await readFile(file, "utf8").catch(() => undefined) !== contents) {
    await mkdir(resolve(file, ".."), { recursive: true })
    await writeFile(file, contents, "utf8")
  }
  return identity
}
