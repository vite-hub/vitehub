import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { argumentExpression, findProperty, scanModule, staticValue, unwrapExpression, walk } from "@vite-hub/internal/build/scan-module"

import type { ObjectExpression } from "@vite-hub/internal/build/scan-module"

const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"]

/** True for `vitehub({ agent: false })`, `vitehub({ agent: { cli: false } })`, and the same options under `vitehub: {}`. */
function hasAgentOptOut(source: string, file: string): boolean {
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
  walk(module.program, (node) => {
    if (node.type === "Property" && !node.computed && node.key.type === "Identifier" && node.key.name === "vitehub") {
      const value = unwrapExpression(node.value)
      if (value.type === "ObjectExpression") options.push(value)
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && pluginNames.has(node.callee.name)) {
      const value = argumentExpression(node.arguments[0])
      if (value?.type === "ObjectExpression") options.push(value)
    }
  })
  return options.some((object) => {
    const agent = findProperty(object, "agent")?.value
    if (agent === undefined) return false
    if (staticValue(agent) === false) return true
    const cli = agent.type === "ObjectExpression" ? findProperty(agent, "cli")?.value : undefined
    return cli !== undefined && staticValue(cli) === false
  })
}

/** Detects explicit Agent CLI opt-outs without evaluating the project config. */
export async function isAgentCliEnabled(rootDir: string): Promise<boolean> {
  // Nuxt owns discovery whenever both config families exist, matching loadViteHubCliConfig.
  const owner = configExtensions.some(extension => existsSync(join(rootDir, `nuxt.config.${extension}`))) ? "nuxt" : "vite"
  for (const extension of configExtensions) {
    const path = join(rootDir, `${owner}.config.${extension}`)
    if (existsSync(path)) return !hasAgentOptOut(await readFile(path, "utf8"), path)
  }
  return true
}
