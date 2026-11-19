import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { detectStyle, end, findProperty, indentAt, isReference, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { addViteHubOptions, ConfigEditor, createLineResolver, useViteHubModule } from "../shared/config-editor.ts"
import { detectNuxtModule } from "../shared/detect.ts"
import { findModuleEntry, literalValue, readNuxtConfig, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { assertModuleRemoved } from "../shared/removed-module.ts"
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

interface Collection {
  name: string
  /** Source of the `glob()` options. */
  glob: string
  schema?: string
  schemaNode?: Node
}

function readSource(node: Node, code: string, style: CodeStyle, followUp: (message: string) => void): string | undefined {
  const quote = (value: string) => quoteString(value, style)
  const literal = literalValue(node)
  const object = staticOptionsObject(node)
  if (!object && typeof literal !== "string") {
    followUp(`source is ${code.slice(start(node), end(node))}, which the codemod cannot read. Write a glob() Source for it by hand.`)
    return undefined
  }
  let include = typeof literal === "string" ? literal : undefined
  let prefix: string | undefined
  let cwd = "content"
  const ignore: string[] = []
  for (const property of object?.properties ?? []) {
    if (property.type !== "ObjectProperty") {
      followUp("source contains a computed option. Write the glob() Source by hand.")
      return undefined
    }
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
  if (/^[!/]|\\|(?:^|\/)\.\.(?:\/|$)/.test(include) || ignore.some(pattern => /^[!/]|\\/.test(pattern))) {
    followUp("source contains a glob that cannot be translated safely. Write its Source by hand.")
    return undefined
  }
  const fields = [`cwd: ${quote(cwd)}`, `include: ${quote(include)}`]
  if (prefix !== undefined) {
    const star = include.indexOf("*")
    const base = star < 0 ? "" : include.slice(0, star)
    if ((base && !/^(?:[\w.-]+\/)+$/.test(base)) || (star < 0 && /[?{}[\]()]/.test(include))) {
      followUp(`source.prefix for ${include} cannot be preserved by glob(). Write its Source by hand.`)
      return undefined
    }
    if (base) {
      if (ignore.some(pattern => !pattern.startsWith(base) || pattern.length === base.length)) {
        followUp(`source.exclude cannot be safely rebased from ${cwd}/ to ${posix.join(cwd, base)}. Write its Source by hand.`)
        return undefined
      }
      fields.splice(0, 2, `cwd: ${quote(posix.join(cwd, base.slice(0, -1)))}`, `include: ${quote(include.slice(base.length))}`)
      ignore.splice(0, ignore.length, ...ignore.map(pattern => pattern.slice(base.length)))
    }
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
  const failures: FollowUp[] = []
  for (const entry of collections.properties) {
    if (entry.type !== "ObjectProperty") throw codemodError(`${file}:${line(entry)}: Migrate computed collection entries by hand.`)
    const name = keyName(entry.key, entry.computed)
    const call = unwrapExpression(entry.value)
    const follow = (message: string) => followUps.push({ file, line: line(entry), message: `Collection ${name}: ${message}` })
    const fail = (message: string) => failures.push({ file, line: line(entry), message: `Collection ${name}: ${message}` })
    const definition = call.type === "CallExpression" && call.callee.type === "Identifier" && call.callee.name === "defineCollection" && call.arguments[0]
      ? staticOptionsObject((call as CallExpression).arguments[0]!)
      : undefined
    if (!name || !definition) {
      fail("it is not defineCollection({ ... }) with an object literal. Write its Source by hand.")
      continue
    }
    const source = findProperty(definition, "source")
    const sourceText = source && readSource(source.value, code, style, fail)
    if (!sourceText) {
      if (!source) fail("it has no source. Write its Source by hand.")
      continue
    }
    const collection: Collection = { name, glob: sourceText }
    for (const option of (definition as ObjectExpression).properties) {
      if (option.type !== "ObjectProperty") throw codemodError(`${file}:${line(option)}: Migrate computed options of collection ${name} by hand.`)
      const key = keyName(option.key, option.computed)
      if (key === "schema") {
        // Keep the lines of the schema, relative to the line of its property.
        const indent = indentAt(code, start(option))
        collection.schema = code.slice(start(option.value), end(option.value)).split("\n").map((text, index) => index && text.startsWith(indent) ? text.slice(indent.length) : text).join("\n")
        collection.schemaNode = option.value
      }
      else if (key === "type" && literalValue(option.value) === "data") follow("it is a data collection. Add json() or yaml() from comark-content to plugins in server/content.ts, so Content parses its files.")
      else if (key !== "type" && key !== "source") follow(`${key} has no ViteHub Content equivalent, so the codemod dropped it.`)
    }
    result.push(collection)
  }
  if (!result.length || failures.length) throw codemodError(`${result.length ? "Not all collections" : "No collection"} of ${file} could be moved:\n${failures.map(entry => `  ${entry.file}:${entry.line} ${entry.message}`).join("\n")}`)
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

  // server/content.ts keeps the app's own imports, such as a shared schema, and takes z from zod.
  const quote = (value: string) => quoteString(value, style)
  const semicolon = style.semicolons ? ";" : ""
  const schemas = collections.some(collection => collection.schema)
  const zNames = new Set<string>()
  const bindings = new Set<string>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    for (const specifier of statement.specifiers) {
      if (statement.source.value !== moduleName) bindings.add(specifier.local.name)
      else if (specifier.type === "ImportSpecifier" && keyName(specifier.imported, false) === "z") {
        bindings.add(specifier.local.name)
        zNames.add(specifier.local.name)
      }
    }
  }
  const usedZ = new Set<string>()
  for (const collection of collections) {
    if (!collection.schemaNode) continue
    walk(collection.schemaNode, (node, ancestors) => {
      if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && keyName(node.property, node.computed) === "editor") {
        throw codemodError(`${file}:${line(node)}: Collection ${collection.name} uses the Nuxt Content .editor() schema helper. Migrate its schema by hand.`)
      }
      if (node.type === "Identifier" && (ancestors.length === 0 || isReference(node, ancestors.at(-1)))) {
        if (!bindings.has(node.name)) throw codemodError(`${file}:${line(node)}: Collection ${collection.name} schema references ${node.name}, which is not a migrated import. Move the schema by hand.`)
        if (zNames.has(node.name)) usedZ.add(node.name)
      }
    })
  }
  const zImports = [...usedZ].map(name => name === "z" ? "z" : `z as ${name}`).join(", ")
  const imports = [
    `import { ${schemas ? "contentSource, " : ""}defineContent } from ${quote("vite-hub/content")}${semicolon}`,
    `import { glob } from ${quote("vite-hub/source")}${semicolon}`,
    ...(zImports ? [`import { ${zImports} } from ${quote("zod")}${semicolon}`] : []),
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
  try {
    parseProgram(definition, { typescript: true })
  }
  catch {
    throw codemodError(`${file}: The generated imports or schemas conflict. Migrate the schemas by hand.`)
  }
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
  assertModuleRemoved(config.fileName, configCode, moduleName)
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
  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: [moduleName, "better-sqlite3"], add: ["vite-hub", "@vite-hub/content"], within: zImports ? { zod: "^3.25.0 || ^4.0.0" } : undefined })
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
