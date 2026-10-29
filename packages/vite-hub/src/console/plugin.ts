import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { normalizeRetention, readColocatedAgentSkills } from "@vite-hub/agent/vite"

import type { AgentInvocationsOptions, AgentRetentionPolicy } from "@vite-hub/agent/server"
import type { ConsoleAgentEntry, ConsoleBuildCatalog } from "./build.ts"
import type { ConsoleJournal } from "../storage-config.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

import { consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { createConsoleInvocationsIdentity } from "./internal.ts"
import { resolveConsoleProjectNameFromRoot } from "./project.ts"
import { consoleRuntimeReaderModule, describeConsoleContributedSections, describeConsoleDocumentEditors, describeConsoleRuntimeReaders } from "./contributions.ts"
import { withConsoleDocumentEditorSections } from "./build.ts"
import { consoleD1MaxSizeError } from "./retention.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

function resolveConsoleRuntimeRoot(): string {
  const root = [
    fileURLToPath(new URL("./runtime", import.meta.url)),
    fileURLToPath(new URL("./console/runtime", import.meta.url)),
  ].find(root => ["page.get.ts", "page.get.js"].some(file => existsSync(join(root, "server", file))))
  if (!root) throw viteHubErrorDiagnostics.VITE_HUB_B0001({ message: "[vitehub] Could not locate the packaged Console runtime." })
  return root
}
export const consoleRuntimeRoot: string = resolveConsoleRuntimeRoot()
export const consolePublicRoot: string = join(consoleRuntimeRoot, "public/console")
function readConsoleOutput(root: string): string {
  if (!existsSync(root)) return ""
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) files.push(file)
    }
  }
  visit(root)
  return files.sort().map(file => `${file.slice(consoleRuntimeRoot.length)}\0${readFileSync(file)}`).join("\0")
}

/** A short id of the generated Console output and the Console client. It is the same for the same Console. */
function consoleBuildId(contents: string): string {
  return createHash("sha256")
    .update(contents)
    .update("\0")
    .update(readConsoleOutput(consoleRuntimeRoot))
    .update("\0")
    .update(readConsoleOutput(consolePublicRoot))
    .update("\0")
    .update(readConsoleOutput(join(consoleRuntimeRoot, "server")))
    .update("\0")
    .update(readConsoleOutput(join(consoleRuntimeRoot, "pages")))
    .update("\0")
    .update(readConsoleOutput(join(consoleRuntimeRoot, "components")))
    .digest("hex")
    .slice(0, 16)
}

function renderRetentionLimit(value: AgentRetentionPolicy[keyof AgentRetentionPolicy]): string {
  return value === undefined ? "undefined" : JSON.stringify(value)
}

/**
 * Validates `console.retention` before code generation. The libSQL journal accepts every limit.
 * The D1 journal rejects maxSize, because D1 reports the size of the whole app database.
 */
export function assertConsoleRetention(retention: AgentRetentionPolicy | undefined, journal: ConsoleJournal | undefined): void {
  if (retention === undefined) return
  const { maxSize } = normalizeRetention(retention, {
    label: "console.retention",
    defaults: { maxAgeMs: false, maxRecords: false, maxSize: false },
    size: "any",
    error: message => viteHubErrorDiagnostics.VITE_HUB_B0015({ message: `[vitehub] ${message}` }),
  })
  if (maxSize !== false && journal && "d1Binding" in journal) throw consoleD1MaxSizeError()
}
/**
 * The Console access policy that generated output installs. Every Console data route checks it.
 * `check.module` is a generated Console Auth middleware that exports `checkConsoleAccess`, and `readConsoleUser` for a session.
 * `check.appRoutes` lists the app Auth access routes that protect the Console.
 * `authorize` is the `console.authorize` server file.
 */
export interface ConsoleAccessBuild {
  mode: "open" | "auth" | "cloudflare-access" | "local"
  authorize?: string
  check?: { module: string } | { appRoutes: readonly { authorize: boolean, index: number, method?: string, route: string }[] }
  /** Path of the sign-in page under the application mount, such as `/sign-in`. */
  signInPage?: string
}

interface ConsoleRuntimeCapabilityImport {
  exportName: string
  name: string
}

const consoleRuntimeCapabilityImports: readonly ConsoleRuntimeCapabilityImport[] = [
  { exportName: "blob", name: "blob" },
  { exportName: "connections", name: "connections" },
  { exportName: "content", name: "content" },
  { exportName: "console", name: "console" },
  { exportName: "agentDb", name: "db" },
  { exportName: "email", name: "email" },
  { exportName: "kv", name: "kv" },
]

function renderConsoleRuntimeCapabilities(imports: Record<string, false | string> | undefined): { imports: string[], install?: string } {
  if (!imports) return { imports: [] }
  const capabilities = consoleRuntimeCapabilityImports.flatMap(({ exportName, name }) => {
    const module = imports[name]
    if (!module) return []
    const alias = `vitehubConsoleAgent${name[0]!.toUpperCase()}${name.slice(1)}`
    return [{ alias, exportName, module, name }]
  })
  if (!capabilities.length) return { imports: [] }
  return {
    imports: capabilities.map(({ alias, exportName, module }) => `import { ${exportName} as ${alias} } from ${JSON.stringify(module)}`),
    install: `capabilities: { ${capabilities.map(({ alias, name }) => `${name}: ${alias}`).join(", ")} }`,
  }
}

function renderConsoleAccess(access: ConsoleAccessBuild | undefined): { imports: string[], install: string[] } {
  if (!access) return { imports: [], install: [] }
  const imports: string[] = []
  const setup: string[] = []
  const fields = [`mode: ${JSON.stringify(access.mode)}`]
  if (access.check && "module" in access.check) {
    const module = JSON.stringify(pathToFileURL(access.check.module).href)
    if (access.mode === "auth") {
      imports.push(`import { checkConsoleAccess as vitehubConsoleAccessCheck, readConsoleUser as vitehubConsoleUser } from ${module}`)
      fields.push("check: vitehubConsoleAccessCheck", "user: vitehubConsoleUser")
    }
    else {
      imports.push(`import { checkConsoleAccess as vitehubConsoleAccessCheck } from ${module}`)
      fields.push("check: vitehubConsoleAccessCheck")
    }
  }
  else if (access.check) {
    // App Auth: require a session, and the authorize callbacks of the Auth access routes that match the request.
    const routes = JSON.stringify(access.check.appRoutes)
    imports.push(
      'import { getAuthForRequest as vitehubGetAuthForRequest, requireAuthAccessRoutes as vitehubRequireAuthAccessRoutes, withAuthorization as vitehubWithAuthorization } from "#vitehub/auth/server"',
      'import { createConsoleAppAuthAccess as vitehubCreateConsoleAppAuthAccess, createConsoleAppAuthPages as vitehubCreateConsoleAppAuthPages } from "vite-hub/console/auth"',
    )
    fields.push("check: vitehubConsoleAppAccess.check", "user: vitehubConsoleAppAccess.user", "signIn: vitehubConsoleAppPages.signIn", "authBasePath: vitehubConsoleAppPages.authBasePath")
    setup.push("const vitehubConsoleAppPages = vitehubCreateConsoleAppAuthPages(vitehubGetAuthForRequest)")
    setup.push(`const vitehubConsoleAppAccess = vitehubCreateConsoleAppAuthAccess({ routes: ${routes}, getAuthForRequest: vitehubGetAuthForRequest, requireAuthAccessRoutes: vitehubRequireAuthAccessRoutes, requireSession: vitehubWithAuthorization(true, () => undefined) })`)
  }
  if (access.authorize) {
    imports.push(`import vitehubConsoleAuthorize from ${JSON.stringify(pathToFileURL(access.authorize).href)}`)
    fields.push("authorize: vitehubConsoleAuthorize")
  }
  if (access.signInPage) fields.push(`signInPage: ${JSON.stringify(access.signInPage)}`)
  return {
    imports,
    install: [
      ...setup,
      `installConsoleAccess({ ${fields.join(", ")} })`,
    ],
  }
}

function renderConsoleNitroPlugin(
  projectRoot: string,
  configuredSections: readonly ConsoleSectionId[],
  agents: readonly ConsoleAgentEntry[],
  catalog: ConsoleBuildCatalog,
  blobStores: readonly string[],
  fixture?: string,
  fixtureSnapshot = fixture ? readConsoleFixture(fixture) : undefined,
  runtimeBinding?: string,
  invoke = false,
  observations?: AgentInvocationsOptions["observations"],
  journal?: ConsoleJournal,
  independentAuth: true | "cloudflare-access" | false = false,
  retention?: AgentRetentionPolicy,
  access?: ConsoleAccessBuild,
  runtimeCapabilityImports?: Record<string, false | string>,
  development = false,
  applicationBase = "/",
): string {
  assertConsoleRetention(retention, journal)
  const accessCode = renderConsoleAccess(access)
  const operations = (catalog.operations ?? []).map(contribution => ({ ...contribution, module: consoleRuntimeReaderModule(contribution.module) }))
  const sections = withConsoleDocumentEditorSections(configuredSections, catalog)
  const documentEditors = describeConsoleDocumentEditors(sections, catalog.documents ?? {})
  const runtimeCapabilities = renderConsoleRuntimeCapabilities(runtimeCapabilityImports)
  const definitions = agents.map((agent, index) => {
    const skills = readColocatedAgentSkills(agent.handler)
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
  const contributedSections = describeConsoleContributedSections(sections, applicationBase)
  const runtimeReaders = describeConsoleRuntimeReaders(sections)
  const definitionsEnabled = databaseEnabled || contributedSections.length > 0
  const revision = fixtureSnapshot ? consoleFixtureRevision(fixtureSnapshot) : undefined
  const fixtureSource = fixtureSnapshot ? `JSON.parse(${JSON.stringify(JSON.stringify(fixtureSnapshot))})` : undefined
  return [
    `import { ${access ? "installConsoleAccess, " : ""}installConsoleBuild, installConsoleDevelopment, installConsoleOperations, installConsoleProjectName, installConsoleSections } from "vite-hub/console/sections"`,
    ...operations.map((operation, index) => `import { ${operation.export} as vitehubConsoleOperations${index} } from ${JSON.stringify(operation.module)}`),
    ...accessCode.imports,
    ...(agentsEnabled ? runtimeCapabilities.imports : []),
    ...(blobEnabled
      ? [
          `import { installConsoleBlob } from "vite-hub/console/blob"`,
          `import { blob as vitehubConsoleBlob } from "vite-hub/blob"`,
        ]
      : []),
    ...(agentsEnabled
      ? [`import { installConsoleAgentDefinitions, installConsoleFixtureInvocations } from "vite-hub/console/server"`, `import { agentWithColocatedSkills } from "vite-hub/_internal/agent/runtime/workflow"`]
      : []),
    ...(definitionsEnabled ? [`import { installConsoleDefinitions${schedulesEnabled ? ", installConsoleSchedules" : ""} } from "vite-hub/console/definitions"`] : []),
    ...(definitionsEnabled
      ? runtimeReaders.map((reader, index) => `import { ${reader.export} as vitehubConsoleRuntimeReader${index} } from ${JSON.stringify(reader.module)}`)
      : []),
    ...(databaseEnabled
      ? [
          `import { installConsoleDatabase } from "vite-hub/console/database"`,
          `import { databases as vitehubConsoleDatabases } from "vite-hub/database/drizzle"`,
        ]
      : []),
    ...(sections.includes("env") ? [`import { describeServerEnv } from "#vitehub/env/description"`, `import { installConsoleEnv } from "vite-hub/console/env"`] : []),
    ...(documentEditors.length ? [`import { installConsoleDocuments } from "vite-hub/console/documents"`] : []),
    ...documentEditors.map((editor, index) => `import { ${editor.export} as vitehubConsoleDocumentActions${index} } from ${JSON.stringify(editor.module)}`),
    ...agents.map((agent, index) => `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    `installConsoleDevelopment(${JSON.stringify(projectRoot)}, ${JSON.stringify(development)})`,
    ...accessCode.install,
    `installConsoleSections(${JSON.stringify(projectRoot)}, ${JSON.stringify(sections)}${independentAuth ? `, ${JSON.stringify(independentAuth)}` : ""})`,
    ...(blobEnabled
      ? [`installConsoleBlob(${JSON.stringify(projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(blobStores)})`]
      : []),
    ...(sections.includes("env") ? [`installConsoleEnv(${JSON.stringify(projectRoot)}, describeServerEnv(), async request => { try { return await (await import("#vitehub/env/server")).manageServerEnv(request) } catch { return Response.json({ message: "Env management is unavailable." }, { status: 503, headers: { "cache-control": "no-store" } }) } }, async event => (await import("#vitehub/env/server")).inspectServerEnv(event))`] : []),
    // Always installed, so agent tools see the operations before the first RPC call.
    `installConsoleOperations([${operations.map((operation, index) => `{ operations: vitehubConsoleOperations${index}, plugin: ${JSON.stringify(operation.plugin)} }`).join(", ")}])`,
    `installConsoleProjectName(${JSON.stringify(projectRoot)}, ${JSON.stringify(resolveConsoleProjectNameFromRoot(projectRoot))})`,
    // The application module loads on the first document request, so the Console does not start Content at boot.
    ...(documentEditors.length
      ? [`installConsoleDocuments(${JSON.stringify(projectRoot)}, { ${documentEditors.map((editor, index) => `${JSON.stringify(editor.section)}: { actions: vitehubConsoleDocumentActions${index}, load: () => import(${JSON.stringify(pathToFileURL(editor.entry).href)}) }`).join(", ")} })`]
      : []),
    ...(definitionsEnabled ? [`installConsoleDefinitions(${JSON.stringify(projectRoot)}, ${JSON.stringify(catalog.content)}, ${JSON.stringify(contributedSections)}${runtimeReaders.length ? `, { ${runtimeReaders.map((reader, index) => `${JSON.stringify(reader.section)}: vitehubConsoleRuntimeReader${index}`).join(", ")} }` : ""})`] : []),
    ...(schedulesEnabled ? [`installConsoleSchedules(${JSON.stringify(projectRoot)}, {${runnableSchedules}})`] : []),
    ...(databaseEnabled
      ? [`installConsoleDatabase(${JSON.stringify(projectRoot)}, vitehubConsoleDatabases, ${JSON.stringify(catalog.content.databases?.kind === "definition-catalog" ? catalog.content.databases.definitions.map(definition => definition.name) : [])})`]
      : []),
    ...(agentsEnabled
      ? fixture
        ? [
            `const vitehubConsoleInvocations = installConsoleFixtureInvocations(${JSON.stringify(projectRoot)}, ${JSON.stringify(fixture)}, ${fixtureSource}, ${JSON.stringify(revision)}, ${JSON.stringify(runtimeBinding)})`,
            `installConsoleAgentDefinitions([${definitions}], { invocations: vitehubConsoleInvocations${runtimeCapabilities.install ? `, ${runtimeCapabilities.install}` : ""} })`,
          ]
        : [`installConsoleAgentDefinitions([${definitions}], { projectRoot: ${JSON.stringify(projectRoot)}${invoke ? ", invoke: true" : ""}${observations !== undefined ? `, observations: ${JSON.stringify(observations)}` : ""}${journal && "databaseUrl" in journal ? `, databaseUrl: ${JSON.stringify(journal.databaseUrl)}` : ""}${journal && "d1Binding" in journal ? `, d1: { binding: ${JSON.stringify(journal.d1Binding)}, env: async () => (await import("cloudflare:workers")).env }` : ""}${retention !== undefined ? `, retention: { maxAge: ${renderRetentionLimit(retention.maxAge)}, maxRecords: ${renderRetentionLimit(retention.maxRecords)}, maxSize: ${renderRetentionLimit(retention.maxSize)} }` : ""}${runtimeCapabilities.install ? `, ${runtimeCapabilities.install}` : ""} })`]
      : []),
    "export default function viteHubConsolePlugin() {}",
    "",
  ].join("\n")
}

export async function writeConsoleNitroPlugin(
  file: string,
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  agents: readonly ConsoleAgentEntry[],
  catalog: ConsoleBuildCatalog,
  blobStores: readonly string[],
  fixture?: string,
  runtimeBinding?: string,
  invoke = false,
  observations: AgentInvocationsOptions["observations"] = undefined,
  active: () => boolean = () => true,
  journal?: ConsoleJournal,
  independentAuth: true | "cloudflare-access" | false = false,
  retention?: AgentRetentionPolicy,
  access?: ConsoleAccessBuild,
  runtimeCapabilityImports?: Record<string, false | string>,
  development = false,
  applicationBase = "/",
): Promise<string> {
  const snapshot = fixture ? readConsoleFixture(fixture) : undefined
  const identity = createConsoleInvocationsIdentity(
    projectRoot,
    fixture,
    snapshot ? consoleFixtureRevision(snapshot) : undefined,
    runtimeBinding,
  )
  if (!active()) return identity
  const rendered = renderConsoleNitroPlugin(projectRoot, sections, agents, catalog, blobStores, fixture, snapshot, runtimeBinding, invoke, observations, journal, independentAuth, retention, access, runtimeCapabilityImports, development, applicationBase)
  // The build id is a hash of the rest of the output, so it changes only when an open Console would be outdated.
  const contents = `${rendered}installConsoleBuild(${JSON.stringify(projectRoot)}, ${JSON.stringify(consoleBuildId(rendered))})\n`
  if (await readFile(file, "utf8").catch(() => undefined) !== contents) {
    await mkdir(resolve(file, ".."), { recursive: true })
    await writeFile(file, contents, "utf8")
  }
  if (fixture && snapshot) {
    // The invocation runtime loads Drizzle and libSQL. Load it only for a Console fixture.
    const { installConsoleFixtureInvocations } = await import("./runtime/server/invocations.ts")
    installConsoleFixtureInvocations(projectRoot, fixture, snapshot, consoleFixtureRevision(snapshot), runtimeBinding)
  }
  return identity
}
