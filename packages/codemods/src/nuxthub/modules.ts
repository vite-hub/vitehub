import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { findProperty, line, parseProgram, walk } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import { literalValue, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { moduleName } from "./config.ts"

import type { Node, ObjectExpression } from "@babel/types"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { FollowUp } from "../types.ts"

const guide = "https://vitehub.dev/docs/getting-started/migrate-from-nuxthub#modules-that-expect-nuxthub"
const contributions = "https://vitehub.dev/docs/database/configure#contribute-tables-from-a-nuxt-module"
const customMigration = "Put the SQL in a migration that you write by hand with `vitehub database generate --custom`."

const hookMessages = new Map<string, string>(Object.entries({
  "hub:db:schema:extend": `NuxtHub's hub:db:schema:extend hook adds tables here. ViteHub does not call NuxtHub hooks, so these tables are not in the Database. Contribute them from a Vite plugin with \`vitehub.databases\`, which takes the module and export of an object of Drizzle tables. ViteHub then generates their migrations. See ${contributions}.`,
  "hub:db:migrations:dirs": `NuxtHub's hub:db:migrations:dirs hook adds migration folders here. ViteHub does not call NuxtHub hooks, so it does not apply this SQL. A \`vitehub.databases\` contribution adds tables, and ViteHub generates their migrations. ${customMigration} See ${contributions}.`,
  "hub:db:queries:paths": `NuxtHub's hub:db:queries:paths hook adds SQL that runs after the migrations. ViteHub does not call NuxtHub hooks and has no such queries. ${customMigration}`,
}))

const scripts = "{ts,mts,js,mjs,cjs}"
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/dist/**"]

/** The app root and the local layers: `layers/*` and relative `extends` paths. */
function layerDirectories(cwd: string, config: NuxtConfigFile, layers: string[]): string[] {
  const directories = new Set([".", ...layers])
  const property = findProperty(config.root, "extends")
  const value = property && unwrapExpression(property.value)
  const entries: Array<Node | null> = value?.type === "ArrayExpression" ? value.elements : value ? [value] : []
  for (const entry of entries) {
    const node = entry?.type === "ArrayExpression" ? entry.elements[0] : entry
    if (node?.type !== "StringLiteral" || !node.value.startsWith(".")) continue
    const directory = posix.normalize(node.value)
    if (!directory.startsWith("..") && existsSync(join(cwd, directory))) directories.add(directory)
  }
  return [...directories]
}

/** Finds NuxtHub database hooks in the app config, local modules, and local layers. */
async function findHooks(cwd: string, config: NuxtConfigFile): Promise<FollowUp[]> {
  const layers = await glob(["layers/*"], { cwd, onlyDirectories: true })
  const patterns = layerDirectories(cwd, config, layers.map(layer => layer.replace(/\/$/, ""))).flatMap((directory) => {
    const base = directory === "." ? "" : `${directory}/`
    return [`${base}nuxt.config.${scripts}`, `${base}modules/**/*.${scripts}`]
  })
  const files = (await glob(patterns, { cwd, ignore: ignored })).sort()
  const followUps: FollowUp[] = []
  for (const file of files) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!code.includes("hub:db:")) continue
    let program
    try {
      program = parseProgram(code, { typescript: !/\.[cm]?js$/.test(file) })
    }
    catch {
      followUps.push({ file, message: "This file mentions NuxtHub database hooks, but the codemod could not parse it. Check it by hand." })
      continue
    }
    const seen = new Set<string>()
    walk(program, (node) => {
      const value = node.type === "StringLiteral" ? node.value : node.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0]?.value.cooked : undefined
      const message = value === undefined ? undefined : hookMessages.get(value)
      if (!value || !message || seen.has(value)) return
      seen.add(value)
      followUps.push({ file, line: line(node), message })
    })
  }
  return followUps
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Installed dependencies that peer on, or depend on, `@nuxthub/core`. */
async function findNuxtHubDependents(cwd: string, dependencyRoot: string): Promise<FollowUp[]> {
  const packageFile = join(cwd, "package.json")
  if (!existsSync(packageFile)) return []
  const code = await readFile(packageFile, "utf8")
  const manifest: unknown = JSON.parse(code)
  if (!isRecord(manifest)) return []
  const names = new Set<string>()
  for (const field of ["dependencies", "devDependencies"]) {
    const value = manifest[field]
    if (isRecord(value)) for (const name of Object.keys(value)) names.add(name)
  }
  names.delete(moduleName)
  const followUps: FollowUp[] = []
  for (const name of [...names].sort()) {
    const installed = join(dependencyRoot, "node_modules", name, "package.json")
    if (!existsSync(installed)) continue
    const dependency: unknown = JSON.parse(await readFile(installed, "utf8"))
    if (!isRecord(dependency)) continue
    const field = (["peerDependencies", "dependencies"] as const).find(key => isRecord(dependency[key]) && moduleName in dependency[key])
    if (!field) continue
    const index = code.indexOf(JSON.stringify(name))
    followUps.push({
      file: "package.json",
      ...(index >= 0 ? { line: code.slice(0, index).split("\n").length } : {}),
      message: `${name} needs ${moduleName} (${field === "peerDependencies" ? "peer dependency" : "dependency"}). With it installed, the package manager installs NuxtHub again and the module starts it next to ViteHub. ViteHub does not emulate NuxtHub's module APIs. Remove ${name} or replace it. See ${guide}.`,
    })
  }
  return followUps
}

/** `studio.media.external` uploads media only through NuxtHub Blob. */
function findStudioExternalMedia(config: NuxtConfigFile): FollowUp[] {
  const option = (object: ObjectExpression | undefined, name: string) => {
    const property = object && findProperty(object, name)
    return property && staticOptionsObject(property.value)
  }
  const media = option(option(config.root, "studio"), "media")
  const external = media && findProperty(media, "external")
  if (!external || literalValue(external.value) !== true) return []
  return [{
    file: config.fileName,
    line: line(external),
    message: `nuxt-studio uploads external media only to NuxtHub Blob. Without ${moduleName}, it warns and keeps media in public/. ViteHub does not emulate NuxtHub's module APIs. Keep media as public assets and remove media.external. See ${guide}.`,
  }]
}

/** Follow-ups for local modules, layers, and installed packages that use NuxtHub's module APIs. */
export async function findNuxtHubModuleFollowUps(cwd: string, config: NuxtConfigFile, dependencyRoot = cwd): Promise<FollowUp[]> {
  return [...await findHooks(cwd, config), ...findStudioExternalMedia(config), ...await findNuxtHubDependents(cwd, dependencyRoot)]
}
