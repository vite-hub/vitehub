import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { readColocatedAgentSkills } from "@vite-hub/agent/vite"

import type { AgentInvocationRetentionOptions, AgentInvocationsOptions } from "@vite-hub/agent/server"
import type { ConsoleAgentEntry, ConsoleBuildCatalog } from "./build.ts"
import type { ConsoleJournal } from "../storage-config.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

import { consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { createConsoleInvocationsIdentity } from "./internal.ts"
import { resolveConsoleProjectNameFromRoot } from "./project.ts"
import { describeConsoleContributedSections, describeConsoleRuntimeReaders } from "./contributions.ts"

function renderRetentionLimit(value: number | false | undefined): string {
  if (value === undefined) return "undefined"
  if (Number.isNaN(value)) return "NaN"
  if (value === Number.POSITIVE_INFINITY) return "Infinity"
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity"
  // Keep invalid non-serializable limits subject to runtime validation.
  return JSON.stringify(value) ?? "null"
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
      'import { readConsoleSessionUser as vitehubReadConsoleSessionUser } from "vite-hub/console/auth"',
    )
    fields.push(
      `check: event => { const path = event.url.pathname; const method = (event.req?.method ?? event.request?.method ?? "GET").toUpperCase(); const matched = ${routes}.filter(route => { if (route.method && route.method !== method) return false; if (path === route.route) return true; if (!route.route.endsWith("/**")) return false; const base = route.route.slice(0, -3); return path === base || path.startsWith(base + "/") }); if (!matched.length) return vitehubRequireSession(event); const indexes = matched.map(route => route.index); const required = matched.filter(route => route.authorize).map(route => route.index); return vitehubRequireAuthAccessRoutes(event, indexes, undefined, required, { redirectToSignIn: false }) }`,
      "user: event => vitehubReadConsoleSessionUser(vitehubGetAuthForRequest(event.req, undefined, event), event.req)",
    )
  }
  if (access.authorize) {
    imports.push(`import vitehubConsoleAuthorize from ${JSON.stringify(pathToFileURL(access.authorize).href)}`)
    fields.push("authorize: vitehubConsoleAuthorize")
  }
  return {
    imports,
    install: [
      ...(access.check && "appRoutes" in access.check ? ["const vitehubRequireSession = vitehubWithAuthorization(true, () => undefined)"] : []),
      `installConsoleAccess({ ${fields.join(", ")} })`,
    ],
  }
}

function renderConsoleNitroPlugin(
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  agents: readonly ConsoleAgentEntry[],
  catalog: ConsoleBuildCatalog,
  blobStores: readonly string[],
  kvStores: readonly string[],
  fixture?: string,
  fixtureSnapshot = fixture ? readConsoleFixture(fixture) : undefined,
  runtimeBinding?: string,
  invoke = false,
  observations?: AgentInvocationsOptions["observations"],
  journal?: ConsoleJournal,
  independentAuth: true | "cloudflare-access" | false = false,
  retention?: AgentInvocationRetentionOptions,
  access?: ConsoleAccessBuild,
  runtimeCapabilityImports?: Record<string, false | string>,
): string {
  const accessCode = renderConsoleAccess(access)
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
  const kvEnabled = sections.includes("kv")
  const schedulesEnabled = sections.includes("schedules")
  const runnableSchedules = (invoke ? catalog.manualSchedules ?? [] : [])
    .map(schedule => ` [${JSON.stringify(schedule.name)}]: () => import(${JSON.stringify(pathToFileURL(schedule.handler).href)}),`)
    .join("")
    .replace(/,$/, " ")
  const contributedSections = describeConsoleContributedSections(sections)
  const runtimeReaders = describeConsoleRuntimeReaders(sections)
  const definitionsEnabled = databaseEnabled || contributedSections.length > 0
  const revision = fixtureSnapshot ? consoleFixtureRevision(fixtureSnapshot) : undefined
  const fixtureSource = fixtureSnapshot ? `JSON.parse(${JSON.stringify(JSON.stringify(fixtureSnapshot))})` : undefined
  return [
    `import { ${access ? "installConsoleAccess, " : ""}installConsoleProjectName, installConsoleSections } from "vite-hub/console/sections"`,
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
    ...(kvEnabled
      ? [
          `import { installConsoleKV } from "vite-hub/console/kv"`,
          `import { kv as vitehubConsoleKV } from "vite-hub/kv"`,
        ]
      : []),
    ...(sections.includes("env") ? [`import { describeServerEnv } from "#vitehub/env/description"`, `import { installConsoleEnv } from "vite-hub/console/env"`] : []),
    ...agents.map((agent, index) => `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    ...accessCode.install,
    `installConsoleSections(${JSON.stringify(projectRoot)}, ${JSON.stringify(sections)}${independentAuth ? `, ${JSON.stringify(independentAuth)}` : ""})`,
    ...(blobEnabled
      ? [`installConsoleBlob(${JSON.stringify(projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(blobStores)})`]
      : []),
    ...(sections.includes("env") ? [`installConsoleEnv(${JSON.stringify(projectRoot)}, describeServerEnv(), async request => { try { return await (await import("#vitehub/env/server")).manageServerEnv(request) } catch { return Response.json({ message: "Env management is unavailable." }, { status: 503, headers: { "cache-control": "no-store" } }) } }, async event => (await import("#vitehub/env/server")).inspectServerEnv(event))`] : []),
    `installConsoleProjectName(${JSON.stringify(projectRoot)}, ${JSON.stringify(resolveConsoleProjectNameFromRoot(projectRoot))})`,
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
        : [`installConsoleAgentDefinitions([${definitions}], { projectRoot: ${JSON.stringify(projectRoot)}${invoke ? ", invoke: true" : ""}${observations !== undefined ? `, observations: ${JSON.stringify(observations)}` : ""}${journal && "databaseUrl" in journal ? `, databaseUrl: ${JSON.stringify(journal.databaseUrl)}` : ""}${journal && "d1Binding" in journal ? `, d1: { binding: ${JSON.stringify(journal.d1Binding)}, env: async () => (await import("cloudflare:workers")).env }` : ""}${retention !== undefined ? `, retention: { maxAgeMs: ${renderRetentionLimit(retention.maxAgeMs)}, maxRecords: ${renderRetentionLimit(retention.maxRecords)} }` : ""}${runtimeCapabilities.install ? `, ${runtimeCapabilities.install}` : ""} })`]
      : []),
    ...(kvEnabled
      ? [`installConsoleKV(${JSON.stringify(projectRoot)}, vitehubConsoleKV, ${JSON.stringify(kvStores)})`]
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
  kvStores: readonly string[],
  fixture?: string,
  runtimeBinding?: string,
  invoke = false,
  observations: AgentInvocationsOptions["observations"] = undefined,
  active: () => boolean = () => true,
  journal?: ConsoleJournal,
  independentAuth: true | "cloudflare-access" | false = false,
  retention?: AgentInvocationRetentionOptions,
  access?: ConsoleAccessBuild,
  runtimeCapabilityImports?: Record<string, false | string>,
): Promise<string> {
  const snapshot = fixture ? readConsoleFixture(fixture) : undefined
  const identity = createConsoleInvocationsIdentity(
    projectRoot,
    fixture,
    snapshot ? consoleFixtureRevision(snapshot) : undefined,
    runtimeBinding,
  )
  if (!active()) return identity
  const contents = renderConsoleNitroPlugin(projectRoot, sections, agents, catalog, blobStores, kvStores, fixture, snapshot, runtimeBinding, invoke, observations, journal, independentAuth, retention, access, runtimeCapabilityImports)
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
