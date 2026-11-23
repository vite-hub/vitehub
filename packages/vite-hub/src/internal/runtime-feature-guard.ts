import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { importOptionalOwner } from "./optional-owners.ts"

import type { CallExpression, Expression, ObjectExpression } from "@vite-hub/internal/build/scan-module"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

type ScanModule = typeof import("@vite-hub/internal/build/scan-module")

/** The config scanner parses with `vite`. A production install can leave out that optional peer. */
export async function loadConfigScanner(load: () => Promise<ScanModule> = () => import("@vite-hub/internal/build/scan-module")): Promise<ScanModule | undefined> {
  try {
    return await load()
  }
  catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ERR_MODULE_NOT_FOUND" && /'vite'/.test(error.message)) return
    throw error
  }
}

interface ViteHubOptionObjects {
  active: ObjectExpression | undefined
  options: ObjectExpression[]
  nuxtConfig?: ObjectExpression
  scan: ScanModule
}

async function viteHubOptionObjects(rootDir: string, loadScanner: () => Promise<ScanModule | undefined> = loadConfigScanner): Promise<ViteHubOptionObjects | undefined> {
  const owner = configExtensions.some(extension => existsSync(join(rootDir, `nuxt.config.${extension}`))) ? "nuxt" : "vite"
  const file = configExtensions.map(extension => join(rootDir, `${owner}.config.${extension}`)).find(path => existsSync(path))
  if (!file) return
  const source = await readFile(file, "utf8")
  const scan = await loadScanner()
  if (!scan) return
  const { argumentExpression, defaultExportExpression, findProperty, objectProperties, scanModule, staticString, unwrapExpression, walk } = scan
  const module = scanModule(source, file)
  const pluginNames = new Set<string>()
  const defineConfigNames = new Set(owner === "nuxt" ? ["defineNuxtConfig"] : [])
  for (const statement of module.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
      if (statement.source.value === "vite-hub" && imported === "vitehub") pluginNames.add(specifier.local.name)
      if (owner === "vite" && statement.source.value === "vite" && imported === "defineConfig") defineConfigNames.add(specifier.local.name)
    }
  }
  const options: ObjectExpression[] = []
  const calls: CallExpression[] = []
  walk(module.program, (node) => {
    if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (property.type !== "Property" || property.computed || property.key.type !== "Identifier" || property.key.name !== "vitehub") continue
        const value = unwrapExpression(property.value)
        if (value.type === "ObjectExpression") options.push(value)
      }
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && pluginNames.has(node.callee.name)) {
      const value = argumentExpression(node.arguments[0])
      calls.push(node)
      if (value?.type === "ObjectExpression") options.push(value)
    }
  })
  if (module.errors.length > 0) return { active: undefined, options, scan }
  const literal = (node: Expression | undefined): ObjectExpression | undefined =>
    node?.type === "ObjectExpression" && node.properties.every(property => property.type === "Property" && !property.computed) ? node : undefined
  const exported = defaultExportExpression(module)
  const config = literal(exported?.type === "CallExpression" && exported.callee.type === "Identifier" && defineConfigNames.has(exported.callee.name)
    ? argumentExpression(exported.arguments[0])
    : exported)
  let active: ObjectExpression | undefined
  if (config && owner === "vite") {
    const plugins = findProperty(config, "plugins")?.value
    const call = calls.length === 1 ? calls[0] : undefined
    if (call && plugins?.type === "ArrayExpression" && plugins.elements.some(plugin => plugin !== null && argumentExpression(plugin) === call)) {
      active = literal(argumentExpression(call.arguments[0]))
    }
  }
  if (config && owner === "nuxt" && calls.length === 0 && !objectProperties(config).some(property => property.key === "extends" || property.key?.startsWith("$"))) {
    const modules = findProperty(config, "modules")?.value
    const knownModules = !modules || (modules.type === "ArrayExpression" && modules.elements.every((entry) => {
      const value = entry === null ? undefined : argumentExpression(entry)
      if (value?.type !== "ArrayExpression") return staticString(value) !== undefined
      const name = value.elements[0]
      const moduleName = name ? staticString(argumentExpression(name)) : undefined
      return moduleName !== undefined && moduleName !== "vite-hub/nuxt"
    }))
    if (knownModules) active = literal(findProperty(config, "vitehub")?.value)
  }
  return { active, options, scan, ...(owner === "nuxt" && config ? { nuxtConfig: config } : {}) }
}

/**
 * Detects explicit Agent CLI opt-outs without evaluating the project config. Without `vite`, it cannot parse the config,
 * so the command stays enabled: `vitehub agent invocations` reads a journal and needs no project.
 */
export async function isAgentCliEnabled(rootDir: string, loadScanner: () => Promise<ScanModule | undefined> = loadConfigScanner): Promise<boolean> {
  const config = await viteHubOptionObjects(rootDir, loadScanner)
  if (!config) return true
  const { findProperty, staticValue } = config.scan
  return !config.options.some((object) => {
    const agent = findProperty(object, "agent")?.value
    if (agent === undefined) return false
    if (staticValue(agent) === false) return true
    const cli = agent.type === "ObjectExpression" ? findProperty(agent, "cli")?.value : undefined
    return cli !== undefined && staticValue(cli) === false
  })
}

/**
 * Whether `vitehub agent emulator` runs without loading the project. It does when the command names its emulator, with
 * `--url` or `VITEHUB_EMULATE_URL`, or asks for help, or when the directory has no Vite or Nuxt config. Otherwise the
 * project loads, so the command finds the dev server under the configured Vite `root` and respects `agent.cli: false`.
 */
export function isAgentEmulatorStandalone(args: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): boolean {
  if (env.VITEHUB_EMULATE_URL) return true
  if (args.some(arg => arg === "--url" || arg.startsWith("--url=") || arg === "--help" || arg === "-h")) return true
  return !["nuxt", "vite"].some(owner => configExtensions.some(extension => existsSync(join(cwd, `${owner}.config.${extension}`))))
}

/**
 * The `file:` Agent State URL that the default Invocation journal goes next to, as `agentJournalStateUrl()` selects it
 * from the evaluated options. Reads only literal values: a computed value, a spread, or a `dataDir` gives undefined, and
 * the CLI keeps its default journal.
 */
export async function readAgentJournalStateUrl(rootDir: string, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const config = await viteHubOptionObjects(rootDir)
  const options = config?.active
  if (!config || !options) return
  const { findProperty, objectProperties, staticString, staticValue } = config.scan
  const literalObject = (node: Expression | undefined): ObjectExpression | undefined =>
    node?.type === "ObjectExpression" && objectProperties(node).every(property => property.key !== undefined) ? node : undefined
  if (findProperty(options, "dataDir")) return
  if (staticString(findProperty(options, "host")?.value) !== "node") return
  if (env.VITEHUB_HOST && env.VITEHUB_HOST !== "node") return
  const agent = literalObject(findProperty(options, "agent")?.value)
  if (!agent) return
  const invocations = findProperty(agent, "invocations")?.value
  if (invocations !== undefined && staticValue(invocations) !== undefined) {
    const setting = literalObject(invocations)
    if (!setting || findProperty(setting, "store") || findProperty(setting, "databaseUrl")) return
  }
  const providers = literalObject(findProperty(agent, "providers")?.value)
  const state = providers && literalObject(findProperty(providers, "state")?.value)
  if (!state) return
  const driver = findProperty(state, "driver")?.value
  if (driver !== undefined && !["auto", "libsql", "sqlite"].includes(staticString(driver) ?? "")) return
  const url = staticString(findProperty(state, "url")?.value)?.trim()
  return url && /^file:/i.test(url) ? url : undefined
}

/** The Postgres default Database that keeps the default Invocation journal of a Node server. */
export interface AgentJournalPostgres {
  driver?: "node-postgres"
  /** The connection URL. Without it, the driver reads the PG* environment variables. */
  url?: string
}

/**
 * The Postgres default Database where a Node production build keeps the default Invocation journal, as
 * `defaultJournalDatabase()` selects it, with the connection that the runtime uses. Reads only literal config values.
 * Undefined when the journal is elsewhere, or when the Database runs on PGlite, which only the dev server opens.
 */
export async function readAgentJournalPostgres(rootDir: string, env: Readonly<Record<string, string | undefined>>): Promise<AgentJournalPostgres | undefined> {
  const config = await viteHubOptionObjects(rootDir)
  const options = config?.active
  if (!config || !options) return
  const { findProperty, objectProperties, staticString, staticValue } = config.scan
  const literalObject = (node: Expression | undefined): ObjectExpression | undefined =>
    node?.type === "ObjectExpression" && objectProperties(node).every(property => property.key !== undefined) ? node : undefined
  if (findProperty(options, "dataDir")) return
  const host = findProperty(options, "host")?.value
  const configuredHost = host === undefined ? undefined : staticString(host)
  if (host !== undefined && configuredHost === undefined) return
  if (configuredHost !== undefined && configuredHost !== "node" && configuredHost !== "vercel" && configuredHost !== "netlify" && configuredHost !== "cloudflare" && configuredHost !== "deno") return
  const { hostFromNitroPreset, resolveBuildHost } = await import("@vite-hub/internal/deployment")
  const nitro = config.nuxtConfig && findProperty(config.nuxtConfig, "nitro")?.value
  const nitroOptions = literalObject(nitro)
  if (configuredHost === undefined && nitro !== undefined && !nitroOptions) return
  const preset = nitroOptions && findProperty(nitroOptions, "preset")?.value
  const configuredPreset = staticString(preset)
  if (configuredHost === undefined && preset !== undefined && configuredPreset === undefined) return
  if (resolveBuildHost(configuredHost ?? hostFromNitroPreset(configuredPreset), env) !== "node") return
  const agent = findProperty(options, "agent")?.value
  const agentOptions = literalObject(agent)
  if (agent !== undefined && staticValue(agent) !== true && !agentOptions) return
  if (agent === undefined) {
    const { hasDefinitionFiles } = await import("@vite-hub/internal/definition-catalog")
    const { features } = await import("@vite-hub/internal/features")
    if (!features.agent.enabledByDiscovery?.some(name => hasDefinitionFiles(join(rootDir, "server", name)))) return
  }
  const invocations = agentOptions && findProperty(agentOptions, "invocations")?.value
  if (invocations !== undefined && staticValue(invocations) !== true) {
    const setting = literalObject(invocations)
    if (!setting || findProperty(setting, "store") || findProperty(setting, "databaseUrl")) return
  }
  const database = findProperty(options, "database")?.value
  if (database === undefined) return
  const databaseOptions = staticValue(database) === true ? undefined : literalObject(database)
  if (staticValue(database) !== true && !databaseOptions) return
  const projectRootValue = databaseOptions && findProperty(databaseOptions, "projectRoot")?.value
  const projectRoot = projectRootValue ? staticString(projectRootValue) : undefined
  if (projectRootValue && projectRoot === undefined) return
  const owner = await importOptionalOwner("@vite-hub/database", () => import("@vite-hub/database/config"))
  if (!owner) return
  const root = resolve(rootDir, projectRoot ?? ".")
  let resolved: ReturnType<typeof owner.resolveDBViteConfig>
  try {
    resolved = owner.resolveDBViteConfig(undefined, root, { implicitDefault: true, provisionState: {}, ...(projectRoot === undefined ? {} : { serverDirs: [resolve(root, "server")] }) })
  }
  catch {
    return
  }
  const target = resolved?.databases.default
  if (target?.dialect !== "postgresql" || target.driver === "pglite") return
  const definition = resolved?.definitions.find(item => item.name === "default")
  if (definition && !owner.readDatabaseDefinitionConnectionIsStatic(definition.handler)) return
  const url = owner.resolveConfigValue(target.connection?.url, { ...env })?.trim()
  if (!url && !Object.entries(env).some(([name, value]) => name.startsWith("PG") && value?.trim())) return
  return { ...(target.driver === "node-postgres" ? { driver: target.driver } : {}), ...(url ? { url } : {}) }
}
