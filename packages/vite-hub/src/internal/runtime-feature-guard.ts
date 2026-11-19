import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

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
  /**
   * The options that take effect: the only `vitehub({...})` call in the exported Vite plugins, or
   * the `vitehub` key of a Nuxt config without spreads or `vite-hub/nuxt` module options. Undefined otherwise.
   */
  active: ObjectExpression | undefined
  /** Every literal `vitehub()` option object and `vitehub: {}` key in the file. */
  options: ObjectExpression[]
  scan: ScanModule
}

/**
 * The literal `vitehub()` options and `vitehub: {}` keys of a config file, read without evaluating it. Undefined without
 * a config file, or without `vite` to parse it.
 */
async function viteHubOptionObjects(rootDir: string, loadScanner: () => Promise<ScanModule | undefined> = loadConfigScanner): Promise<ViteHubOptionObjects | undefined> {
  // Nuxt owns discovery whenever both config families exist, matching loadViteHubCliConfig.
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
    // Only object literal members: destructuring patterns also have Property nodes, with pattern values.
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
  return { active, options, scan }
}

/**
 * Detects explicit Agent CLI opt-outs without evaluating the project config. Without `vite`, it cannot parse the config,
 * so the command stays enabled: `vitehub agent invocations` reads a journal and needs no project.
 */
export async function isAgentCliEnabled(rootDir: string, loadScanner: () => Promise<ScanModule | undefined> = loadConfigScanner): Promise<boolean> {
  const config = await viteHubOptionObjects(rootDir, loadScanner)
  if (!config) return true
  const { findProperty, staticValue } = config.scan
  // True for `vitehub({ agent: false })`, `vitehub({ agent: { cli: false } })`, and the same options under `vitehub: {}`.
  return !config.options.some((object) => {
    const agent = findProperty(object, "agent")?.value
    if (agent === undefined) return false
    if (staticValue(agent) === false) return true
    const cli = agent.type === "ObjectExpression" ? findProperty(agent, "cli")?.value : undefined
    return cli !== undefined && staticValue(cli) === false
  })
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
  // An object with a spread or a computed key can hold other values at runtime.
  const literalObject = (node: Expression | undefined): ObjectExpression | undefined =>
    node?.type === "ObjectExpression" && objectProperties(node).every(property => property.key !== undefined) ? node : undefined
  if (findProperty(options, "dataDir")) return
  // Only the Node host puts the journal next to State. Without `host`, ViteHub reads the host from the build
  // environment, which the CLI does not know. `VITEHUB_HOST` from `vitehub deploy` wins over `host`.
  if (staticString(findProperty(options, "host")?.value) !== "node") return
  if (env.VITEHUB_HOST && env.VITEHUB_HOST !== "node") return
  const agent = literalObject(findProperty(options, "agent")?.value)
  if (!agent) return
  // The default journal only: no `store`, and no `databaseUrl` of its own.
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
