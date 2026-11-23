import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, findProperty, parseProgram } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { isCodemodError } from "../error-diagnostics.ts"
import { readDependencies } from "../shared/detect.ts"
import { localLayerDirectories } from "../shared/layers.ts"
import { findModuleEntry, literalValue, objectProperty, readNuxtConfig, unwrapExpression } from "../shared/nuxt-config.ts"
import { addServerImports, appServerImportNames, freeReferences, serverDirectory, viteHubServerImportSources } from "../shared/server-imports.ts"

import type { File } from "@babel/types"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"

const moduleName = "vite-hub/nuxt"
const ignoredPatterns = ["**/node_modules/**", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"]
const helperPattern = new RegExp(`\\b(?:${[...viteHubServerImportSources.keys()].join("|")})\\b`)

const reportedNitroHelpers = new Set(["createError", "defineEventHandler", "eventHandler", "getQuery", "getRouterParam", "readBody", "useRuntimeConfig"])

interface Project {
  config: NuxtConfigFile
  serverFiles: string[]
}

function listsViteHub(config: NuxtConfigFile): boolean {
  if (findModuleEntry(config, moduleName)) return true
  const locals = new Set<string>()
  for (const statement of config.program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== moduleName) continue
    for (const specifier of statement.specifiers) if (specifier.type === "ImportDefaultSpecifier") locals.add(specifier.local.name)
  }
  const modules = findProperty(config.root, "modules")
  const list = modules ? unwrapExpression(modules.value) : undefined
  if (list?.type !== "ArrayExpression") return false
  return list.elements.some((element) => {
    const entry = element ? unwrapExpression(element) : undefined
    const head = entry?.type === "ArrayExpression" && entry.elements[0] ? unwrapExpression(entry.elements[0]) : entry
    return head?.type === "Identifier" && locals.has(head.name)
  })
}

/**
 * Whether nuxt.config turns on Nuxt's server auto-imports, as `vite-hub/nuxt` reads them: `experimental.nitroAutoImports`,
 * `nitroLegacy: true`, or a `nitroLegacy` object without `imports: false`. A value that is not a literal counts as on,
 * so the codemod leaves an app that may keep its auto-imports.
 */
export function serverAutoImportsOn(config: NuxtConfigFile): boolean {
  const experimental = objectProperty(config.root, "experimental")
  const switchProperty = experimental ? findProperty(experimental, "nitroAutoImports") : undefined
  if (switchProperty && literalValue(switchProperty.value) !== false) return true
  const legacy = findProperty(config.root, "nitroLegacy")
  if (!legacy) return false
  const value = unwrapExpression(legacy.value)
  if (value.type === "BooleanLiteral") return value.value
  if (value.type !== "ObjectExpression") return true
  const imports = findProperty(value, "imports")
  return !imports || literalValue(imports.value) !== false
}

async function readProject(cwd: string): Promise<Project | undefined> {
  let config: NuxtConfigFile
  try {
    config = await readNuxtConfig(cwd)
  }
  catch (error) {
    if (isCodemodError(error)) return undefined
    throw error
  }
  if (!listsViteHub(config) && !(await readDependencies(cwd)).has("vite-hub")) return undefined
  const dirs = (await localLayerDirectories(cwd, config)).map(layer => serverDirectory(config, layer))
  const files = await glob(dirs.map(dir => `${dir}/**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx}`), { cwd, ignore: ignoredPatterns })
  return { config, serverFiles: files.sort() }
}

function parse(file: string, code: string): File {
  return parseProgram(code, { jsx: file.endsWith("x"), typescript: /\.[cm]?tsx?$/.test(file) })
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const project = await readProject(cwd)
  const empty = { edits: [], followUps: [], notes: [], nextSteps: [] }
  if (!project) return { summary: `found no Nuxt app with ${moduleName}`, ...empty }
  if (serverAutoImportsOn(project.config)) {
    return { summary: `found Nuxt server auto-imports on in ${project.config.fileName}, so server files keep the ViteHub auto-imports`, ...empty }
  }
  const appNames = await appServerImportNames(cwd, project.config)
  const skip = new Set(appNames.keys())
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const kept = new Map<string, Set<string>>()
  const nitroFiles: string[] = []
  let added = 0
  for (const file of project.serverFiles) {
    const source = await readFile(join(cwd, file), "utf8")
    const helpers = helperPattern.test(source)
    if (!helpers && ![...reportedNitroHelpers].some(name => source.includes(name))) continue
    let program: File
    try {
      program = parse(file, source)
    }
    catch (error) {
      if (helpers) followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Import the ViteHub helpers that it uses from their vite-hub/* paths by hand.` })
      continue
    }
    if (freeReferences(program, reportedNitroHelpers).size) nitroFiles.push(file)
    if (!helpers) continue
    const output = new MagicString(source)
    const result = addServerImports({ code: source, program, output, style: detectStyle(source, program), skip })
    for (const name of result.skipped) kept.set(name, (kept.get(name) ?? new Set()).add(file))
    if (!result.added.length) continue
    added += result.added.length
    edits.push({ path: file, before: source, after: output.toString() })
  }

  const notes: string[] = []
  for (const [name, files] of [...kept].sort(([left], [right]) => left.localeCompare(right))) {
    const from = viteHubServerImportSources.get(name)
    notes.push(`${appNames.get(name)} gives \`${name}\`, and Nuxt still auto-imports it, so ${files.size} file(s) keep the app's \`${name}\`. Import ViteHub's from "${from}" where you need it.`)
  }
  if (nitroFiles.length) {
    notes.push(`Nuxt 5 also stops auto-importing the Nitro and H3 helpers, such as defineEventHandler, in ${nitroFiles.length} server file(s), for example ${nitroFiles[0]}. Import them as the Nuxt 5 build error lists, from "nitro/h3" or "nuxt/server".`)
  }
  return {
    summary: edits.length ? `added ${added} vite-hub import(s) to ${edits.length} server file(s)` : "found no server file that uses a ViteHub helper without an import",
    edits,
    followUps,
    notes,
    nextSteps: edits.length ? ["Run `npx nuxi prepare`, then type-check the app."] : [],
  }
}

export const nuxtServerImports: Codemod = {
  name: "nuxt-server-imports",
  description: "Import the ViteHub server helpers, such as kv and sendQueue, from vite-hub/* in Nuxt server files that used the auto-imports",
  usage: "[dir]",
  detectAfterEdits: true,
  async detect({ cwd }) {
    const project = await readProject(cwd)
    if (!project || serverAutoImportsOn(project.config)) return undefined
    const skip = new Set((await appServerImportNames(cwd, project.config)).keys())
    const names = new Set([...viteHubServerImportSources.keys()].filter(name => !skip.has(name)))
    for (const file of project.serverFiles) {
      const source = await readFile(join(cwd, file), "utf8")
      if (!helperPattern.test(source)) continue
      let program: File
      try {
        program = parse(file, source)
      }
      catch {
        continue
      }
      const [name] = freeReferences(program, names).keys()
      if (name) return { reason: `${file} uses ${name} without an import, and Nuxt server auto-imports are off` }
    }
    return undefined
  },
  run: migrate,
}
