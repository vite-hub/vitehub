import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { detectStyle, end, findProperty, indentAt, keyName, line, parseProgram, quoteString, start } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { addViteHubOptions, ConfigEditor, createLineResolver, useViteHubModule } from "../shared/config-editor.ts"
import { detectNuxtModule } from "../shared/detect.ts"
import { findModuleEntry, literalValue, readNuxtConfig, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { codemodError } from "../error-diagnostics.ts"
import { docus } from "../docus/index.ts"

import type { CallExpression, File, ObjectExpression } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const moduleName = "@nuxt/content"
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/dist/**", "**/.vitehub/**"]
const guide = "https://vitehub.dev/docs/content/get-started"

/** Nuxt Content reads that have no one-to-one ViteHub Content call. */
const readFollowUps: Array<[RegExp, string]> = [
  [/\bqueryCollection\s*\(/, "queryCollection() is Nuxt Content's query builder. Read a page with content.get(path) from server/content.ts, or createContentClient().get(path) from vite-hub/content/client in app code."],
  [/\bqueryCollection(?:Navigation|ItemSurroundings|SearchSections)\s*\(/, "ViteHub Content has no navigation, surroundings, or search sections helper. Build them from content.list(), or use @vite-hub/docs for a docs site."],
  [/<ContentRenderer\b/, "Render a Content document with the Markdown component of ViteHub UI. See https://vitehub.dev/docs/ui/markdown#content-pages."],
]

/** The fixed folders of a glob before its first wildcard, and the rest. */
function splitGlob(pattern: string): { base: string, rest: string } {
  const segments = pattern.split("/")
  const index = segments.findIndex(segment => /[*?[{]/.test(segment))
  if (index < 0) return { base: pattern, rest: "**" }
  return { base: segments.slice(0, index).join("/"), rest: segments.slice(index).join("/") }
}

interface Collection {
  name: string
  /** Source of the `glob()` options. */
  glob: string
  schema?: string
}

function readSource(node: Node, code: string, style: CodeStyle, followUp: (message: string) => void): string | undefined {
  const quote = (value: string) => quoteString(value, style)
  const literal = literalValue(node)
  if (typeof literal === "string") return `{ cwd: ${quote("content")}, include: ${quote(literal)} }`
  const object = staticOptionsObject(node)
  if (!object) {
    followUp(`source is ${code.slice(start(node), end(node))}, which the codemod cannot read. Write a glob() Source for it by hand.`)
    return undefined
  }
  let include: string | undefined
  let prefix: string | undefined
  let cwd = "content"
  const ignore: string[] = []
  for (const property of object.properties) {
    if (property.type !== "ObjectProperty") continue
    const key = keyName(property.key, property.computed)
    const value = unwrapExpression(property.value)
    const text = literalValue(value)
    if (key === "include" && typeof text === "string") include = text
    else if (key === "prefix" && typeof text === "string") prefix = text
    else if (key === "cwd" && typeof text === "string") cwd = text
    else if (key === "exclude" && value.type === "ArrayExpression" && value.elements.every(element => element && typeof literalValue(element) === "string")) {
      ignore.push(...value.elements.map(element => String(literalValue(element!))))
    }
    else {
      followUp(`source.${key ?? "..."} is not a string the codemod can read${key === "repository" ? ". Read a repository with github() from vite-hub/source" : ""}. Write the glob() Source by hand.`)
      return undefined
    }
  }
  if (!include) {
    followUp("source has no include, so the codemod cannot read it. Write a glob() Source by hand.")
    return undefined
  }
  const fields = [`cwd: ${quote(cwd)}`, `include: ${quote(include)}`]
  // Nuxt Content's prefix replaces the fixed folders of include. glob() puts its prefix before the whole key.
  if (prefix !== undefined) {
    const { base, rest } = splitGlob(include)
    fields.splice(0, 2, `cwd: ${quote(posix.join(cwd, base))}`, `include: ${quote(rest)}`)
    // exclude paths are relative to the content folder, and ignore to the new cwd.
    const kept = ignore.filter(pattern => !base || pattern.startsWith(`${base}/`))
    for (const pattern of ignore) if (!kept.includes(pattern)) followUp(`exclude ${pattern} is outside ${base}/, so the codemod dropped it.`)
    ignore.splice(0, ignore.length, ...kept.map(pattern => base ? pattern.slice(base.length + 1) : pattern))
    const trimmed = prefix.replace(/^\/+|\/+$/g, "")
    if (trimmed) fields.push(`prefix: ${quote(trimmed)}`)
  }
  if (ignore.length) fields.push(`ignore: [${ignore.map(quote).join(", ")}]`)
  return `{ ${fields.join(", ")} }`
}

function readCollections(file: string, code: string, program: File, style: CodeStyle, followUps: FollowUp[]): Collection[] {
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  let root = exported?.type === "ExportDefaultDeclaration" ? unwrapExpression(exported.declaration) : undefined
  if (root?.type === "CallExpression" && root.arguments[0]) root = unwrapExpression(root.arguments[0])
  const options = root && staticOptionsObject(root)
  const property = options && findProperty(options, "collections")
  const collections = property && staticOptionsObject(property.value)
  if (!collections) throw codemodError(`${file} must export defineContentConfig({ collections: { ... } }) with an object literal. Write server/content.ts with defineContent() from vite-hub/content by hand.`)
  const result: Collection[] = []
  for (const entry of collections.properties) {
    if (entry.type !== "ObjectProperty") continue
    const name = keyName(entry.key, entry.computed)
    const call = unwrapExpression(entry.value)
    const follow = (message: string) => followUps.push({ file, line: line(entry), message: `Collection ${name}: ${message}` })
    const definition = call.type === "CallExpression" && call.callee.type === "Identifier" && call.callee.name === "defineCollection" && call.arguments[0]
      ? staticOptionsObject((call as CallExpression).arguments[0]!)
      : undefined
    if (!name || !definition) {
      follow("it is not defineCollection({ ... }) with an object literal. Write its Source by hand.")
      continue
    }
    const source = findProperty(definition, "source")
    const sourceText = source && readSource(source.value, code, style, follow)
    if (!sourceText) {
      if (!source) follow("it has no source. Write its Source by hand.")
      continue
    }
    const collection: Collection = { name, glob: sourceText }
    for (const option of (definition as ObjectExpression).properties) {
      if (option.type !== "ObjectProperty") continue
      const key = keyName(option.key, option.computed)
      if (key === "schema") {
        // Keep the lines of the schema, relative to the line of its property.
        const indent = indentAt(code, start(option))
        collection.schema = code.slice(start(option.value), end(option.value)).split("\n").map((text, index) => index && text.startsWith(indent) ? text.slice(indent.length) : text).join("\n")
      }
      else if (key === "type" && literalValue(option.value) === "data") follow("it is a data collection. Add json() or yaml() from comark-content to plugins in server/content.ts, so Content parses its files.")
      else if (key !== "type" && key !== "source") follow(`${key} has no ViteHub Content equivalent, so the codemod dropped it.`)
    }
    result.push(collection)
  }
  return result
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const config = await readNuxtConfig(cwd)
  const [file] = await glob(["content.config.{ts,mts,js,mjs}"], { cwd })
  if (!file) throw codemodError("The app has no content.config.ts. Nuxt Content 3 apps define their collections there. Write server/content.ts with defineContent() from vite-hub/content by hand.")
  const target = "server/content.ts"
  if (existsSync(join(cwd, target))) throw codemodError(`${target} exists already. Merge the collections of ${file} into it by hand.`)
  const code = await readFile(join(cwd, file), "utf8")
  let program: File
  try {
    program = parseProgram(code, { typescript: !/\.m?js$/.test(file) })
  }
  catch {
    throw codemodError(`Cannot parse ${file}. Write server/content.ts with defineContent() from vite-hub/content by hand.`)
  }
  const followUps: FollowUp[] = []
  const style = detectStyle(code, program)
  const collections = readCollections(file, code, program, style, followUps)
  if (!collections.length) throw codemodError(`No collection of ${file} could be moved:\n${followUps.map(entry => `  ${entry.file}:${entry.line} ${entry.message}`).join("\n")}`)

  // server/content.ts keeps the app's own imports, such as a shared schema, and takes z from zod.
  const quote = (value: string) => quoteString(value, style)
  const semicolon = style.semicolons ? ";" : ""
  const schemas = collections.some(collection => collection.schema)
  const usesZ = schemas && program.program.body.some(statement => statement.type === "ImportDeclaration" && statement.source.value === moduleName
    && statement.specifiers.some(specifier => specifier.local.name === "z"))
  const imports = [
    `import { ${schemas ? "contentSource, " : ""}defineContent } from ${quote("vite-hub/content")}${semicolon}`,
    `import { glob } from ${quote("vite-hub/source")}${semicolon}`,
    ...(usesZ ? [`import { z } from ${quote("zod")}${semicolon}`] : []),
  ]
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value === moduleName) continue
    const text = code.slice(start(statement), end(statement))
    // A relative import moves one folder down, into server/.
    imports.push(statement.source.value.startsWith(".") ? text.replace(statement.source.value, posix.join("..", statement.source.value)) : text)
  }
  const indent = style.indent
  const sources = collections.map((collection) => {
    const source = `glob(${collection.glob})`
    const value = collection.schema ? `contentSource(${source}, { schema: ${collection.schema.replaceAll("\n", `\n${indent}${indent}`)} })` : source
    return `${indent}${indent}${/^[A-Za-z_$][\w$]*$/.test(collection.name) ? collection.name : quote(collection.name)}: ${value},`
  })
  const definition = `${imports.join("\n")}\n\nexport default defineContent({\n${indent}// Nuxt Content served every collection to every visitor.\n${indent}access: ${quote("public")},\n${indent}sources: {\n${sources.join("\n")}\n${indent}},\n})${semicolon}\n`
  const edits: FileEdit[] = [{ path: file, before: code, after: null }, { path: target, before: undefined, after: definition }]

  // nuxt.config.
  const editor = new ConfigEditor(config)
  const removed = new Set<Node>()
  const contentOptions = findProperty(config.root, "content")
  if (contentOptions) {
    followUps.push({ file: config.fileName, line: line(contentOptions), message: "The codemod removed the content options of Nuxt Content. Set Markdown plugins with markdown or plugins in server/content.ts." })
    editor.removeItem(contentOptions)
    removed.add(contentOptions)
  }
  const rootEntries = useViteHubModule(editor, config, findModuleEntry(config, moduleName) ? moduleName : undefined)
  const added = addViteHubOptions(editor, config, { options: [], rootEntries, removedRootProperties: removed })
  editor.removeUnusedBindings()
  // A removed root property between two blank lines leaves one of them.
  const configOutput = editor.output.toString()
  const configCode = config.code.includes("\n\n\n") ? configOutput : configOutput.replace(/\n{3,}/g, "\n\n")
  edits.unshift({ path: config.fileName, before: config.code, after: configCode })
  if (added.hostNote) followUps.unshift({ file: config.fileName, line: createLineResolver(configCode)(["vitehub", "host"]), message: added.hostNote })

  // Reads in app and server code.
  for (const source of (await glob(["**/*.{vue,ts,mts,js,mjs}"], { cwd, ignore: [...ignored, "nuxt.config.*", "content.config.*", "**/*.d.ts"] })).sort()) {
    const lines = (await readFile(join(cwd, source), "utf8")).split("\n")
    lines.forEach((text, index) => {
      const found = readFollowUps.find(([pattern]) => pattern.test(text))
      if (found) followUps.push({ file: source, line: index + 1, message: found[1] })
    })
  }
  const numbered = (await glob(["content/**/[0-9]*.*"], { cwd, onlyFiles: false })).filter(path => path.split("/").some(segment => /^\d+\./.test(segment)))
  if (numbered.length) followUps.push({ file: numbered.sort()[0], message: `Nuxt Content dropped order prefixes such as 1. from paths. ViteHub Content keeps them, so ${numbered.length} file${numbered.length === 1 ? "" : "s"} get new paths. Rename them, or keep links that include the prefix.` })

  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: [moduleName, "better-sqlite3"], add: ["vite-hub", "@vite-hub/content"], within: usesZ ? { zod: "^3.25.0 || ^4.0.0" } : undefined })
  if (packageResult.edit) edits.push(packageResult.edit)
  return {
    summary: `moved ${collections.length} collection${collections.length === 1 ? "" : "s"} from ${file} to ${target}${added.host ? `, host "${added.host}"` : ""}.`,
    edits,
    followUps,
    notes: [
      "Each collection became a read-only glob() Source with the same files and paths. Content serves them at /api/content and reads them with content.get(path) and content.list().",
      `The codemod does not rewrite queryCollection() calls or <ContentRenderer>: the read API differs. See ${guide}.`,
    ],
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install vite-hub and @vite-hub/content and remove ${moduleName}.`,
      "Run `npx nuxi prepare`, then replace the reads that the report lists.",
    ],
  }
}

export const nuxtContent: Codemod = {
  name: "nuxt-content",
  description: "Move Nuxt Content collections from content.config.ts to ViteHub Content Sources through vite-hub/nuxt.",
  usage: "[dir]",
  async detect(context) {
    // A Docus site moves with the docus codemod, which keeps its pages and theme.
    if (await docus.detect(context)) return undefined
    if (!existsSync(join(context.cwd, "content.config.ts")) && !(await glob(["content.config.{mts,js,mjs}"], { cwd: context.cwd })).length) return undefined
    return detectNuxtModule(context.cwd, moduleName)
  },
  run: migrate,
}
