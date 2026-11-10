import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"


import type { ConsoleAgentEntry, ConsoleBuildCatalog } from "./build.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

import { resolveConsoleClient } from "./client.ts"
import { consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { consoleRuntimeDigestFile, digestConsoleRuntime } from "./runtime-digest.ts"
import { createConsoleInvocationsIdentity } from "./internal.ts"
import { resolveConsoleProjectNameFromRoot } from "./project.ts"
import { describeConsoleContributedSections, describeConsoleDocumentEditors, describeConsoleRuntimeReaders } from "./contributions.ts"
import { withConsoleDocumentEditorSections } from "./build.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { requireOptionalOwner } from "../internal/optional-owners.ts"
import { generatedModules } from "../internal/generated-modules.ts"
import { ownerModules } from "../internal/owner-modules.ts"

function resolveConsoleRuntimeRoot(): string {
  const root = [
    fileURLToPath(new URL("./runtime", import.meta.url)),
    fileURLToPath(new URL("./console/runtime", import.meta.url)),
  ].find(root => ["page.get.ts", "page.get.js"].some(file => existsSync(join(root, "server", file))))
  if (!root) throw viteHubErrorDiagnostics.VITE_HUB_B0001({ message: "[vitehub] Could not locate the packaged Console runtime." })
  return root
}
export const consoleRuntimeRoot: string = resolveConsoleRuntimeRoot()
/** The ViteHub skill and its well-known index, which the Console serves at `/_vitehub/.well-known/skills`. */
export const consoleSkillsRoot: string = join(consoleRuntimeRoot, "public/skills")
let consoleRuntimeDigest: string | undefined

/**
 * The digest of the packaged Console runtime. The package build writes it, so an installed package does not read the
 * runtime files on each start. Source checkouts compute it once per process.
 */
function readConsoleRuntimeDigest(): string {
  if (consoleRuntimeDigest !== undefined) return consoleRuntimeDigest
  const file = join(consoleRuntimeRoot, consoleRuntimeDigestFile)
  consoleRuntimeDigest = existsSync(file) ? readFileSync(file, "utf8").trim() : digestConsoleRuntime(consoleRuntimeRoot)
  return consoleRuntimeDigest
}

/** A short id of the generated Console output and the Console client. It is the same for the same Console. */
function consoleBuildId(contents: string): string {
  return createHash("sha256")
    .update(contents)
    .update("\0")
    .update(readConsoleRuntimeDigest())
    .digest("hex")
    .slice(0, 16)
}

/**
 * The Console access policy that generated output installs. Every Console data route checks it.
 * `check.module` is a generated Console Auth middleware that exports `checkConsoleAccess`, and `readConsoleUser` for a session.
 * `check.appRoutes` lists the app Auth access routes that protect the Console.
 * `authorize` is the `console.authorize` server file.
 */
export interface ConsoleAccessBuild {
  mode: "open" | "auth" | "cloudflare-access" | "local" | "token"
  authorize?: string
  check?: { module: string } | { appRoutes: readonly { authorize: boolean, index: number, method?: string, route: string }[] }
  /** How MCP clients sign in with OAuth. Only `auth` mode accepts access tokens. `path` is the mounted MCP endpoint. */
  oauth?: { issuer?: string, path: string, resource?: string }
  /** `console.impersonation`. App Auth access then rejects impersonation sessions from the Console. */
  impersonation?: true
  /** Path of the sign-in page under the application mount, such as `/sign-in`. */
  signInPage?: string
  /** `console.origins`, for `token` mode only: the browser origins that may call the data routes with the token. */
  origins?: readonly string[]
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
  const setup: string[] = []
  const afterInstall: string[] = []
  const fields = [`mode: ${JSON.stringify(access.mode)}`]
  // The Better Auth instance that MCP access tokens are checked against, read in-process.
  let oauthAuth: string | undefined
  let oauthAuthorize: string | undefined
  if (access.check && "module" in access.check) {
    const module = JSON.stringify(pathToFileURL(access.check.module).href)
    if (access.mode === "auth") {
      imports.push(`import { authorizeConsoleBearer as vitehubAuthorizeConsoleBearer, checkConsoleAccess as vitehubConsoleAccessCheck, createConsoleAuth as vitehubCreateConsoleAuth, readConsoleUser as vitehubConsoleUser } from ${module}`)
      fields.push("check: vitehubConsoleAccessCheck", "user: vitehubConsoleUser")
      oauthAuth = "(request, event) => vitehubCreateConsoleAuth(request, event)"
      oauthAuthorize = "vitehubAuthorizeConsoleBearer"
    }
    else {
      imports.push(`import { checkConsoleAccess as vitehubConsoleAccessCheck } from ${module}`)
      fields.push("check: vitehubConsoleAccessCheck")
    }
  }
  else if (access.check) {
    // App Auth keeps its session guard and matching route policies; the MCP identity resolver also accepts tokens.
    const routes = JSON.stringify(access.check.appRoutes)
    imports.push(`import { createConsoleAppAuthAccess as vitehubCreateConsoleAppAuthAccess, createConsoleAppAuthPages as vitehubCreateConsoleAppAuthPages } from ${JSON.stringify(generatedModules.consoleSections)}`)
    oauthAuth = "(request, event) => vitehubGetAuthForRequest(request, undefined, event)"
    fields.push("check: vitehubConsoleAppAccess.check", "user: vitehubConsoleAppAccess.user", "signIn: vitehubConsoleAppPages.signIn", "authBasePath: vitehubConsoleAppPages.authBasePath")
    // The Auth server module loads Better Auth. Import it on the first Console request, not when the server starts.
    setup.push(
      'const vitehubAuthServer = () => import("#vitehub/auth/server")',
      "const vitehubGetAuthForRequest = async (request, runtimeOptions, event) => (await vitehubAuthServer()).getAuthForRequest(request, runtimeOptions, event)",
      "const vitehubRequireAuthAccessRoutes = async (...input) => (await vitehubAuthServer()).requireAuthAccessRoutes(...input)",
      "const vitehubRequireSession = async event => (await vitehubAuthServer()).withAuthorization(true, () => undefined)(event)",
      "const vitehubConsoleAppPages = vitehubCreateConsoleAppAuthPages(vitehubGetAuthForRequest)",
      `const vitehubConsoleAppAccess = vitehubCreateConsoleAppAuthAccess({ routes: ${routes}, getAuthForRequest: vitehubGetAuthForRequest, requireAuthAccessRoutes: vitehubRequireAuthAccessRoutes, requireSession: vitehubRequireSession${access.impersonation ? ", impersonation: true" : ""} })`,
    )
    if (access.oauth) {
      imports.push(
        'import { setAuthAccessIdentityResolver as vitehubSetAuthAccessIdentityResolver } from "vite-hub/auth/runtime/server"',
        `import { resolveConsoleAppAuthIdentity as vitehubResolveConsoleAppAuthIdentity } from ${JSON.stringify(generatedModules.consoleSections)}`,
      )
      afterInstall.push(`vitehubSetAuthAccessIdentityResolver(${JSON.stringify(access.oauth.path)}, vitehubResolveConsoleAppAuthIdentity)`)
    }
  }
  if (access.oauth && access.mode === "auth" && oauthAuth) {
    // Only an OAuth build imports the token check, so other builds ship without jose.
    imports.push(`import { verifyConsoleJwt as vitehubVerifyConsoleJwt } from ${JSON.stringify(generatedModules.consoleSections)}`)
    fields.push(`oauth: { ...${JSON.stringify(access.oauth)}, auth: ${oauthAuth}${oauthAuthorize ? `, authorize: ${oauthAuthorize}` : ""}, verify: vitehubVerifyConsoleJwt }`)
  }
  if (access.authorize) {
    imports.push(`import vitehubConsoleAuthorize from ${JSON.stringify(pathToFileURL(access.authorize).href)}`)
    fields.push("authorize: vitehubConsoleAuthorize")
  }
  if (access.impersonation) fields.push("impersonation: true")
  if (access.signInPage) fields.push(`signInPage: ${JSON.stringify(access.signInPage)}`)
  // Install the list even when it is empty, so a reload in the same process revokes origins that were removed.
  afterInstall.push(`vitehubInstallConsoleOrigins(${JSON.stringify(access.origins ?? [])})`)
  return {
    imports,
    install: [
      ...setup,
      `installConsoleAccess({ ${fields.join(", ")} })`,
      ...afterInstall,
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
  independentAuth: true | "cloudflare-access" | false = false,
  access?: ConsoleAccessBuild,
  runtimeCapabilityImports?: Record<string, false | string>,
  development = false,
  applicationBase = "/",
  pageTools = true,
): string {
  const accessCode = renderConsoleAccess(access)
  const operations = catalog.operations ?? []
  const sections = withConsoleDocumentEditorSections(configuredSections, catalog)
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
  const revision = fixtureSnapshot ? consoleFixtureRevision(fixtureSnapshot) : undefined
  const fixtureSource = fixtureSnapshot ? `JSON.parse(${JSON.stringify(JSON.stringify(fixtureSnapshot))})` : undefined
  const runtimeImports = [
    { bindings: "installConsoleOperations", module: generatedModules.consoleOperations },
    ...operations.map((operation, index) => ({ bindings: `${operation.export}: vitehubConsoleOperations${index}`, module: operation.module })),
    // The MCP client SDK loads only for apps that turn the section on.
    ...(mcpClientEnabled ? [{ bindings: "consoleMcpClientOperations: vitehubConsoleMcpClientOperations", module: "vite-hub/console/mcp-client" }] : []),
    ...(blobEnabled ? [{ bindings: "installConsoleBlob", module: generatedModules.consoleBlob }, { bindings: "blob: vitehubConsoleBlob", module: "vite-hub/blob" }] : []),
    ...(definitionsEnabled ? [{ bindings: `installConsoleDefinitions${schedulesEnabled ? ", installConsoleSchedules" : ""}`, module: generatedModules.consoleDefinitions }] : []),
    ...(definitionsEnabled ? runtimeReaders.map((reader, index) => ({ bindings: `${reader.export}: vitehubConsoleRuntimeReader${index}`, module: reader.module })) : []),
    ...(databaseEnabled ? [{ bindings: "installConsoleDatabase", module: generatedModules.consoleDatabase }, { bindings: "databases: vitehubConsoleDatabases", module: "vite-hub/database/drizzle" }] : []),
    ...(sections.includes("env") ? [{ bindings: "describeServerEnv", module: "#vitehub/env/description" }, { bindings: "installConsoleEnv", module: generatedModules.consoleEnv }] : []),
    // Agent Definitions import the Agent runtime, so they load with the Console runtime and not when the server starts.
    // `defineAgent()` of vite-hub/agent resolves the app-wide journal by itself, and the Agent registry names discovered Agents.
    ...(agentsEnabled ? [{ bindings: "installConsoleAgentDefinitions", module: "vite-hub/console/server" }] : []),
    ...(agentsEnabled && agentSkills.some(Boolean) ? [{ bindings: "agentWithColocatedSkills", module: requireOptionalOwner(ownerModules.agentVite, "agent").agentRuntimeModule("runtime/workflow") }] : []),
  ]
  const agentModules = agentsEnabled ? agents.map((agent, index) => ({ binding: `vitehubConsoleAgent${index}`, module: pathToFileURL(agent.handler).href })) : []
  const runtimeInstall = [
    ...(blobEnabled ? [`installConsoleBlob(${JSON.stringify(projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(blobStores)})`] : []),
    ...(sections.includes("env") ? [`installConsoleEnv(${JSON.stringify(projectRoot)}, describeServerEnv(), async (request, options) => { try { return await (await import("#vitehub/env/server")).manageServerEnv(request, options) } catch { return Response.json({ message: "Env management is unavailable." }, { status: 503, headers: { "cache-control": "no-store" } }) } }, async () => (await import("#vitehub/env/server")).inspectServerEnv())`] : []),
    `installConsoleOperations([${[...(mcpClientEnabled ? ["{ operations: vitehubConsoleMcpClientOperations, plugin: \"vite-hub\" }"] : []), ...operations.map((operation, index) => `{ operations: vitehubConsoleOperations${index}, plugin: ${JSON.stringify(operation.plugin)} }`)].join(", ")}], { invoke: ${invoke} })`,
    ...(definitionsEnabled ? [`installConsoleDefinitions(${JSON.stringify(projectRoot)}, ${JSON.stringify(catalog.content)}, ${JSON.stringify(contributedSections)}${runtimeReaders.length ? `, { ${runtimeReaders.map((reader, index) => `${JSON.stringify(reader.section)}: vitehubConsoleRuntimeReader${index}`).join(", ")} }` : ""})`] : []),
    ...(schedulesEnabled ? [`installConsoleSchedules(${JSON.stringify(projectRoot)}, {${runnableSchedules}})`] : []),
    ...(databaseEnabled ? [`installConsoleDatabase(${JSON.stringify(projectRoot)}, vitehubConsoleDatabases, ${JSON.stringify(catalog.content.databases?.kind === "definition-catalog" ? catalog.content.databases.definitions.map(definition => definition.name) : [])})`] : []),
    ...(agentsEnabled
      // Fixture mode installs its journal at startup, below, so Agents that run before the first Console request use it.
      ? [`installConsoleAgentDefinitions([${definitions}], ${fixture ? `{ invocations: vitehubConsoleInvocations${runtimeCapabilities ? `, ${runtimeCapabilities}` : ""} }` : `{ projectRoot: ${JSON.stringify(projectRoot)}${invoke ? ", invoke: true" : ""}${runtimeCapabilities ? `, ${runtimeCapabilities}` : ""} }`})`]
      : []),
  ]
  // The page loads the prebuilt app of @vite-hub/console-client. A Console that serves only the RPC needs no app.
  const client = pageTools ? resolveConsoleClient() : undefined
  return [
    `import { ${access ? "installConsoleAccess, installConsoleOrigins as vitehubInstallConsoleOrigins, " : ""}installConsoleBuild, ${client ? "installConsoleClient, " : ""}installConsoleDevelopment, installConsolePageTool, installConsoleProjectName, installConsoleRuntime, installConsoleSections } from ${JSON.stringify(generatedModules.consoleSections)}`,
    ...accessCode.imports,
    ...(agentsEnabled && fixture ? [`import { installConsoleFixtureInvocations } from "vite-hub/console/server"`] : []),
    ...(documentEditors.length ? [`import { installConsoleDocuments } from ${JSON.stringify(generatedModules.consoleDocuments)}`] : []),
    ...documentEditors.map((editor, index) => `import { ${editor.export} as vitehubConsoleDocumentActions${index} } from ${JSON.stringify(editor.module)}`),
    `installConsoleDevelopment(${JSON.stringify(projectRoot)}, ${JSON.stringify(development)})`,
    ...(client ? [`installConsoleClient(${JSON.stringify({ script: client.script, style: client.style, pageTool: client.pageTool })})`] : []),
    ...accessCode.install,
    `installConsoleSections(${JSON.stringify(projectRoot)}, ${JSON.stringify(sections)}${independentAuth ? `, ${JSON.stringify(independentAuth)}` : ""})`,
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
    ...(agentsEnabled && fixture
      ? [`const vitehubConsoleInvocations = installConsoleFixtureInvocations(${JSON.stringify(projectRoot)}, ${JSON.stringify(fixture)}, ${fixtureSource}, ${JSON.stringify(revision)}, ${JSON.stringify(runtimeBinding)})`]
      : []),
    // The Console link lives in the shared page tools pill.
    pageTools
      ? `export default function viteHubConsolePlugin(nitroApp) { installConsolePageTool(nitroApp, { base: ${JSON.stringify(applicationBase)} }) }`
      : "export default function viteHubConsolePlugin() {}",
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
  active: () => boolean = () => true,
  independentAuth: true | "cloudflare-access" | false = false,
  access?: ConsoleAccessBuild,
  runtimeCapabilityImports?: Record<string, false | string>,
  development = false,
  applicationBase = "/",
  pageTools = true,
): Promise<string> {
  const snapshot = fixture ? readConsoleFixture(fixture) : undefined
  const identity = createConsoleInvocationsIdentity(
    projectRoot,
    fixture,
    snapshot ? consoleFixtureRevision(snapshot) : undefined,
    runtimeBinding,
  )
  if (!active()) return identity
  const rendered = renderConsoleNitroPlugin(projectRoot, sections, agents, catalog, blobStores, fixture, snapshot, runtimeBinding, invoke, independentAuth, access, runtimeCapabilityImports, development, applicationBase, pageTools)
  // The build id is a hash of the rest of the output, so it changes only when an open Console would be outdated.
  const contents = `${rendered}installConsoleBuild(${JSON.stringify(projectRoot)}, ${JSON.stringify(consoleBuildId(rendered))})\n`
  if (await readFile(file, "utf8").catch(() => undefined) !== contents) {
    await mkdir(resolve(file, ".."), { recursive: true })
    await writeFile(file, contents, "utf8")
  }
  if (fixture && snapshot) {
    // The invocation runtime loads Drizzle and libSQL. Load it only for a Console fixture.
    const { installConsoleFixtureInvocations } = await import("./runtime/server/invocations-fixture.ts")
    installConsoleFixtureInvocations(projectRoot, fixture, snapshot, consoleFixtureRevision(snapshot), runtimeBinding)
  }
  return identity
}
