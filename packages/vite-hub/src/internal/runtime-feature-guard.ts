import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Expression, ObjectExpression } from "@vite-hub/internal/build/scan-module"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

type ScanModule = typeof import("@vite-hub/internal/build/scan-module")

interface ViteHubOptionObjects {
  /**
   * The options that take effect, when the file shows them for sure: the only `vitehub({...})` call of a Vite config, or
   * the `vitehub` key of a Nuxt config without spreads or `vite-hub/nuxt` module options. Undefined otherwise.
   */
  active: ObjectExpression | undefined
  /** Every literal `vitehub()` option object and `vitehub: {}` key in the file. */
  options: ObjectExpression[]
  scan: ScanModule
}

/** The literal `vitehub()` options and `vitehub: {}` keys of a config file, read without evaluating it. */
async function viteHubOptionObjects(rootDir: string): Promise<ViteHubOptionObjects | undefined> {
  // Nuxt owns discovery whenever both config families exist, matching loadViteHubCliConfig.
  const owner = configExtensions.some(extension => existsSync(join(rootDir, `nuxt.config.${extension}`))) ? "nuxt" : "vite"
  const file = configExtensions.map(extension => join(rootDir, `${owner}.config.${extension}`)).find(path => existsSync(path))
  if (!file) return
  const source = await readFile(file, "utf8")
  // Runtime-only commands need no Vite installation until there is a project config to inspect.
  const scan = await import("@vite-hub/internal/build/scan-module")
  const { argumentExpression, scanModule, unwrapExpression, walk } = scan
  const module = scanModule(source, file)
  const pluginNames = new Set<string>()
  for (const statement of module.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || statement.source.value !== "vite-hub") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
      if (imported === "vitehub") pluginNames.add(specifier.local.name)
    }
  }
  const options: ObjectExpression[] = []
  const calls: Array<Expression | undefined> = []
  const nuxtConfigs: Expression[] = []
  let moduleOptions = false
  for (const statement of module.program.body) {
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration.type !== "FunctionDeclaration" && statement.declaration.type !== "ClassDeclaration" && statement.declaration.type !== "TSInterfaceDeclaration") {
      nuxtConfigs.push(unwrapExpression(statement.declaration))
    }
  }
  walk(module.program, (node) => {
    // `["vite-hub/nuxt", {...}]` in `modules` wins over the top-level `vitehub` key.
    if (node.type === "ArrayExpression" && node.elements.length > 1 && node.elements[0]?.type === "Literal" && node.elements[0].value === "vite-hub/nuxt") moduleOptions = true
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
      calls.push(value)
      if (value?.type === "ObjectExpression") options.push(value)
    }
  })
  const unwrapConfig = (config: Expression): Expression => {
    const call = config.type === "CallExpression" && config.callee.type === "Identifier" && config.callee.name === "defineNuxtConfig" ? argumentExpression(config.arguments[0]) : undefined
    return call ?? config
  }
  const literal = (node: Expression | undefined): ObjectExpression | undefined =>
    node?.type === "ObjectExpression" && node.properties.every(property => property.type === "Property" && !property.computed) ? node : undefined
  const nuxtConfig = owner === "nuxt" && nuxtConfigs.length === 1 ? literal(unwrapConfig(nuxtConfigs[0]!)) : undefined
  const active = owner === "vite"
    ? calls.length === 1 ? literal(calls[0]) : undefined
    : nuxtConfig && !moduleOptions && calls.length === 0 ? literal(scan.findProperty(nuxtConfig, "vitehub")?.value) : undefined
  return { active, options, scan }
}

/** Detects explicit Agent CLI opt-outs without evaluating the project config. */
export async function isAgentCliEnabled(rootDir: string): Promise<boolean> {
  const config = await viteHubOptionObjects(rootDir)
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
