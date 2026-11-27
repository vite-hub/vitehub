import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, findProperty, parseProgram } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { isCodemodError } from "../error-diagnostics.ts"
import { readDependencies } from "../shared/detect.ts"
import { findModuleEntry, readNuxtConfig, unwrapExpression } from "../shared/nuxt-config.ts"
import { nuxtServerLayout } from "../shared/nuxt-server-layout.ts"
import { allowsNuxt5 } from "../shared/nuxt-version.ts"
import { addServerImports, appServerImports, freeReferences, serverLayoutFollowUps, unknownServerImports, viteHubServerImportSources } from "../shared/server-imports.ts"

import type { File } from "@babel/types"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { NuxtServerLayout } from "../shared/nuxt-server-layout.ts"

const moduleName = "vite-hub/nuxt"
const ignoredPatterns = ["**/node_modules/**", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"]
const helperPattern = new RegExp(`\\b(?:${[...viteHubServerImportSources.keys()].join("|")})\\b`)
const helperNames = new Set(viteHubServerImportSources.keys())

const reportedNitroHelpers = new Set(["createError", "defineEventHandler", "eventHandler", "getQuery", "getRouterParam", "readBody", "useRuntimeConfig"])

interface Project {
  config: NuxtConfigFile
  layout: NuxtServerLayout
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
  const layout = await nuxtServerLayout(cwd, config)
  const dirs = new Set(layout.layers.flatMap(layer => layer.server ?? []))
  const files = await glob([...dirs].map(dir => `${dir}/**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx}`), { cwd, ignore: ignoredPatterns })
  return { config, layout, serverFiles: files.sort() }
}

function parse(file: string, code: string): File {
  return parseProgram(code, { jsx: file.endsWith("x"), typescript: /\.[cm]?tsx?$/.test(file) })
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const project = await readProject(cwd)
  const empty = { edits: [], followUps: [], notes: [], nextSteps: [] }
  if (!project) return { summary: `found no Nuxt app with ${moduleName}`, ...empty }
  if (project.layout.state === "on") {
    return { summary: `found Nuxt server auto-imports on in ${project.config.fileName}, so server files keep the ViteHub auto-imports`, ...empty }
  }
  if (project.layout.state === "unknown") {
    const message = "The effective Nuxt server auto-import settings could not be determined statically. Check which server files need explicit ViteHub imports."
    return { ...empty, summary: message, followUps: [{ file: project.config.fileName, message }] }
  }
  const { names: appNames, unknown } = await appServerImports(cwd, project.layout)
  const skip = new Set(appNames.keys())
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = serverLayoutFollowUps(project.layout)
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
    if (unknown.size) {
      const uncertain = [...freeReferences(program, helperNames).keys()].filter(name => !skip.has(name))
      if (uncertain.length) followUps.push({ file, message: unknownServerImports(unknown, uncertain) })
    }
    const output = new MagicString(source)
    const result = addServerImports({ code: source, program, output, style: detectStyle(source, program), skip: unknown.size ? helperNames : skip })
    for (const name of result.skipped) if (skip.has(name)) kept.set(name, (kept.get(name) ?? new Set()).add(file))
    if (!result.added.length) continue
    added += result.added.length
    edits.push({ path: file, before: source, after: output.toString() })
  }

  const notes: string[] = []
  for (const [name, files] of [...kept].sort(([left], [right]) => left.localeCompare(right))) {
    const from = viteHubServerImportSources.get(name)
    notes.push(`${appNames.get(name)} gives \`${name}\`, and Nuxt still auto-imports it, so ${files.size} file(s) keep the app's \`${name}\`. Import ViteHub's from "${from}" where you need it.`)
  }
  if (nitroFiles.length && await allowsNuxt5(cwd)) {
    notes.push(`Nuxt 5 also stops auto-importing the Nitro and H3 helpers, such as defineEventHandler, in ${nitroFiles.length} server file(s), for example ${nitroFiles[0]}. Import each one from the module that the Nuxt 5 build error names: "nitro/h3" or "nuxt/server".`)
  }
  return {
    summary: edits.length ? `added ${added} vite-hub import(s) to ${edits.length} server file(s)` : followUps.length ? "left server files that need a manual check" : "found no server file that uses a ViteHub helper without an import",
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
    if (!project || project.layout.state === "on") return undefined
    if (project.layout.state === "unknown") return { reason: "the effective Nuxt server auto-import settings could not be determined statically" }
    if (serverLayoutFollowUps(project.layout).length) return { reason: "a Nuxt server directory could not be resolved statically" }
    const { names: appNames, unknown } = await appServerImports(cwd, project.layout)
    const names = new Set([...helperNames].filter(name => !appNames.has(name)))
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
      if (name) return { reason: unknown.size ? `${file} uses ${name}, whose auto-import source could not be determined statically` : `${file} uses ${name} without an import, and Nuxt server auto-imports are off` }
    }
    return undefined
  },
  run: migrate,
}
