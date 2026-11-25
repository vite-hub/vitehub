import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { ConsoleBuildCatalog } from "./build.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"
import type { ConsoleProjectBuild } from "./runtime/server/project.ts"

import { consoleBuildOf } from "./build-info.ts"
import { resolveConsoleProjectName } from "./project.ts"
import { describeConsoleContributedSections, describeConsoleDocumentEditors, describeConsoleRuntimeReaders } from "./contributions.ts"
import { withConsoleDocumentEditorSections } from "./build.ts"
import { consoleOperationModules } from "./operation-modules.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { requireOptionalOwner } from "../internal/optional-owners.ts"
import { generatedModules } from "../internal/generated-modules.ts"
import { ownerModules } from "../internal/owner-modules.ts"
import { setupDevRoute } from "../setup-dev.ts"
import { readViteHubVersion } from "../version.ts"

function resolveConsoleRuntimeRoot(): string {
  const root = [
    fileURLToPath(new URL("./runtime", import.meta.url)),
    fileURLToPath(new URL("./console/runtime", import.meta.url)),
  ].find(root => ["rpc.ts", "rpc.js"].some(file => existsSync(join(root, "server", file))))
  if (!root) throw viteHubErrorDiagnostics.VITE_HUB_B0001({ message: "[vitehub] Could not locate the packaged Console runtime." })
  return root
}
export const consoleRuntimeRoot: string = resolveConsoleRuntimeRoot()

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

export function resolveConsoleRuntimeCapabilityImports(
  imports: Record<string, false | string> | undefined,
  plugins: readonly { name: string }[] | undefined,
): Record<string, false | string> | undefined {
  if (!plugins) return imports
  return {
    ...imports,
    ...(!imports?.email && plugins.some(plugin => plugin.name === "@vite-hub/email/vite") ? { email: "vite-hub/email" } : {}),
    ...(!imports?.realtime && plugins.some(plugin => plugin.name === "@vite-hub/realtime/vite") ? { realtime: "vite-hub/realtime/agent" } : {}),
  }
}

function renderPickedImport(module: string, bindings: string): string {
  return `import(${JSON.stringify(module)}).then(({ ${bindings} }) => ({ ${bindings} }))`
}

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
  const modules = capabilities.map(({ exportName, module }) => renderPickedImport(module, exportName)).join(", ")
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

/**
 * What the generated Console app module installs. The Nuxt module and the Vite plugin both write it with these options.
 * The Console routes import it as `#vitehub/console/app`, so it loads with the first Console request, not at startup.
 */
export interface ConsoleAppModuleOptions {
  /** The generated module file. */
  file: string
  projectRoot: string
  /** The `name` option of `vitehub()`. `project.get` reports it, or the `package.json` name without it. */
  name?: string
  sections: readonly ConsoleSectionId[]
  /** The sections whose operations the app serves, when they differ from `sections`, such as the development RPC without Console options. */
  operationSections?: readonly ConsoleSectionId[]
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
  /** The host and the framework of a production build, which `project.get` reports with its commit. */
  target?: Pick<ConsoleProjectBuild, "framework" | "host">
  runtimeCapabilityImports?: Record<string, false | string>
  development?: boolean
  /** Add the Site access section. The development RPC without Console options leaves it out. */
  site?: boolean
}

type ConsoleAppModuleSectionOptions = Pick<ConsoleAppModuleOptions, "access" | "catalog" | "sections" | "site">

function consoleAppModuleSections({ access, catalog, sections, site = false }: ConsoleAppModuleSectionOptions): ConsoleSectionId[] {
  return withConsoleDocumentEditorSections(site ? [...sections, "site"] : sections, catalog)
    .filter(section => !access?.hiddenSections?.includes(section))
}

/** Whether the generated Console app module registers a document editor, which turns on `import.meta.viteHubConsoleDocuments`. */
export function consoleAppModuleHasDocumentEditors(options: ConsoleAppModuleSectionOptions): boolean {
  return describeConsoleDocumentEditors(consoleAppModuleSections(options), options.catalog.documents ?? {}).length > 0
}

function renderConsoleAppModule(
  {
    projectRoot,
    name,
    sections: configuredSections,
    operationSections = configuredSections,
    navigationSections,
    catalog,
    blobStores,
    invoke = false,
    access,
    runtimeCapabilityImports,
    development = false,
    site = false,
  }: ConsoleAppModuleOptions,
  build: ConsoleProjectBuild | undefined,
): string {
  const agents = catalog.agents
  const accessCode = renderConsoleAccess(access)
  const operations = catalog.operations ?? []
  const sections = consoleAppModuleSections({ access, catalog, sections: configuredSections, site })
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
  const schedulesEnabled = sections.includes("schedules")
  const runnableSchedules = (invoke ? catalog.manualSchedules ?? [] : [])
    .map(schedule => ` [${JSON.stringify(schedule.name)}]: () => import(${JSON.stringify(pathToFileURL(schedule.handler).href)}),`)
    .join("")
    .replace(/,$/, " ")
  const registered = new Map(describeConsoleContributedSections(sections).map(section => [section.id, section]))
  const contributedSections = sections.flatMap((id) => {
    const section = catalog.sectionOverrides?.[id] ?? registered.get(id)
    return section ? [section] : []
  })
  const runtimeReaders = describeConsoleRuntimeReaders(sections).filter(reader => catalog.sectionOverrides?.[reader.section]?.view.kind !== "operation-view")
  const definitionsEnabled = databaseEnabled || contributedSections.length > 0
  const ownOperations = consoleOperationModules
    .filter(entry => entry.enabled({ documents: documentEditors.length > 0, sections: operationSections, site: sections.includes("site") }))
    .map((entry, index) => ({ binding: `vitehubConsoleOwnOperations${index}`, entry }))
  const agentRealtime = ownOperations.some(({ entry }) => entry.module === generatedModules.consoleAgentOperations) ? runtimeCapabilityImports?.realtime : undefined
  const runtimeImports = [
    { bindings: "installConsoleOperations", module: generatedModules.consoleOperations },
    ...ownOperations.map(({ binding, entry }) => ({ bindings: `${entry.export}: ${binding}${agentRealtime && entry.module === generatedModules.consoleAgentOperations ? ", installConsoleAgentRealtime" : ""}`, module: entry.module })),
    ...operations.map((operation, index) => ({ bindings: `${operation.export}: vitehubConsoleOperations${index}`, module: operation.module })),
    ...(blobEnabled ? [{ bindings: "installConsoleBlob", module: generatedModules.consoleBlob }, { bindings: "blob: vitehubConsoleBlob", module: "vite-hub/blob" }] : []),
    ...(definitionsEnabled ? [{ bindings: `installConsoleDefinitions${schedulesEnabled ? ", installConsoleSchedules" : ""}`, module: generatedModules.consoleDefinitions }] : []),
    ...(definitionsEnabled ? runtimeReaders.map((reader, index) => ({ bindings: `${reader.export}: vitehubConsoleRuntimeReader${index}`, module: reader.module })) : []),
    ...(databaseEnabled ? [{ bindings: "installConsoleDatabase", module: generatedModules.consoleDatabase }, { bindings: "databases: vitehubConsoleDatabases", module: "@vite-hub/database/runtime/registry" }] : []),
    ...(sections.includes("env") ? [{ bindings: "describeServerEnv", module: "#vitehub/env/description" }, { bindings: "installConsoleEnv", module: generatedModules.consoleEnv }] : []),
    ...(agentsEnabled ? [{ bindings: "installConsoleAgentDefinitions", module: "vite-hub/console/server" }] : []),
    ...(agentsEnabled && agentSkills.some(Boolean) ? [{ bindings: "agentWithColocatedSkills", module: requireOptionalOwner(ownerModules.agentVite, "agent").agentRuntimeModule("runtime/workflow") }] : []),
  ]
  const agentModules = agentsEnabled ? agents.map((agent, index) => ({ binding: `vitehubConsoleAgent${index}`, module: pathToFileURL(agent.handler).href })) : []
  const runtimeInstall = [
    ...(blobEnabled ? [`installConsoleBlob(${JSON.stringify(projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(blobStores)})`] : []),
    ...(sections.includes("env") ? [`installConsoleEnv(${JSON.stringify(projectRoot)}, describeServerEnv())`] : []),
    ...(agentRealtime ? [`installConsoleAgentRealtime(() => import(${JSON.stringify(agentRealtime)}))`] : []),
    `installConsoleOperations([${[...ownOperations.map(({ binding }) => `{ operations: ${binding}, plugin: "vite-hub" }`), ...operations.map((operation, index) => `{ operations: vitehubConsoleOperations${index}, plugin: ${JSON.stringify(operation.plugin)} }`)].join(", ")}], { invoke: ${invoke} })`,
    ...(definitionsEnabled ? [`installConsoleDefinitions(${JSON.stringify(projectRoot)}, ${JSON.stringify(catalog.content)}, ${JSON.stringify(contributedSections)}${runtimeReaders.length ? `, { ${runtimeReaders.map((reader, index) => `${JSON.stringify(reader.section)}: vitehubConsoleRuntimeReader${index}`).join(", ")} }` : ""})`] : []),
    ...(schedulesEnabled ? [`installConsoleSchedules(${JSON.stringify(projectRoot)}, {${runnableSchedules}})`] : []),
    ...(databaseEnabled ? [`installConsoleDatabase(${JSON.stringify(projectRoot)}, vitehubConsoleDatabases, ${JSON.stringify(catalog.content.databases?.kind === "definition-catalog" ? catalog.content.databases.definitions.map(definition => definition.name) : [])})`] : []),
    ...(agentsEnabled
      ? [`installConsoleAgentDefinitions([${definitions}], { projectRoot: ${JSON.stringify(projectRoot)}${invoke ? ", invoke: true" : ""}${runtimeCapabilities ? `, ${runtimeCapabilities}` : ""} })`]
      : []),
  ]
  return [
    `import { ${access ? "installConsoleAccess, " : ""}${build ? "installConsoleBuild, " : ""}installConsoleDevelopment, installConsoleProjectName, installConsoleRuntime, installConsoleSections, installConsoleVersion } from ${JSON.stringify(generatedModules.consoleSetup)}`,
    ...accessCode.imports,
    ...(documentEditors.length ? [`import { installConsoleDocuments } from ${JSON.stringify(generatedModules.consoleDocuments)}`] : []),
    ...documentEditors.map((editor, index) => `import { ${editor.export} as vitehubConsoleDocumentActions${index} } from ${JSON.stringify(editor.module)}`),
    `installConsoleDevelopment(${JSON.stringify(projectRoot)}, ${JSON.stringify(development)}${development && sections.includes("setup") ? `, ${JSON.stringify(setupDevRoute)}` : ""})`,
    ...accessCode.install,
    `installConsoleSections(${JSON.stringify(projectRoot)}, ${JSON.stringify(sections)}${navigationSections ? `, ${JSON.stringify(navigationSections)}` : ""})`,
    `installConsoleRuntime(async () => {`,
    `  const [${[...runtimeImports.map(entry => `{ ${entry.bindings} }`), ...agentModules.map(entry => entry.binding)].join(", ")}] = await Promise.all([${[...runtimeImports.map(entry => renderPickedImport(entry.module, entry.bindings)), ...agentModules.map(entry => `import(${JSON.stringify(entry.module)})`)].join(", ")}])`,
    "  return () => {",
    ...runtimeInstall.map(line => `    ${line}`),
    "  }",
    "})",
    `installConsoleProjectName(${JSON.stringify(projectRoot)}, ${JSON.stringify(resolveConsoleProjectName(projectRoot, name))})`,
    `installConsoleVersion(${JSON.stringify(readViteHubVersion())})`,
    ...(build ? [`installConsoleBuild(${JSON.stringify(build)})`] : []),
    ...(documentEditors.length
      ? [`installConsoleDocuments(${JSON.stringify(projectRoot)}, { ${documentEditors.map((editor, index) => `${JSON.stringify(editor.section)}: { actions: vitehubConsoleDocumentActions${index}, load: () => import(${JSON.stringify(pathToFileURL(editor.entry).href)}) }`).join(", ")} })`]
      : []),
    "",
  ].join("\n")
}

/** Write the generated Console app module. */
export async function writeConsoleAppModule(options: ConsoleAppModuleOptions): Promise<void> {
  const { file, active = () => true } = options
  if (!active()) return
  const contents = renderConsoleAppModule(options, options.development ? undefined : { ...await consoleBuildOf(options.projectRoot), ...options.target })
  if (await readFile(file, "utf8").catch(() => undefined) !== contents) {
    await mkdir(resolve(file, ".."), { recursive: true })
    await writeFile(file, contents, "utf8")
  }
}
