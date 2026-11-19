import { existsSync } from "node:fs"
import { lstat, readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { end, findProperty, keyName, line, listItemRemoval, parseProgram, quoteString, start } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import packageJson from "../../package.json" with { type: "json" }
import { ConfigEditor, objectPropertyArray } from "../shared/config-editor.ts"
import { readDependencies } from "../shared/detect.ts"
import { findModuleEntry, literalValue, readNuxtConfig, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { editPackageJson } from "../shared/package-json.ts"
import { assertModuleRemoved } from "../shared/removed-module.ts"
import { codemodError, isCodemodError } from "../error-diagnostics.ts"
import { movePage, moveSection, stripOrder } from "./content.ts"

import type { Node, ObjectExpression } from "@babel/types"
import type { CodeStyle } from "@vite-hub/internal/ast"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const layerName = "docus"
const docsModule = "@vite-hub/docs/nuxt"
/** `@vite-hub/docs` peers, at the ranges it supports. `nuxt` and `vue` stay as the app has them. */
const docsPeers: Record<string, string> = {
  "@comark/html": "^0.9.0",
  "@comark/vue": "^0.9.0",
  "@nuxt/ui": "^4.11.0",
  "comark": "^0.9.0",
  "comark-ui": "^0.12.0",
  "tailwindcss": "^4.1.0",
}
const guide = "https://vitehub.dev/docs/docs-site"

/** Docus app config keys and what happens to them. `seo`, `socials`, and `github` move. */
const appConfigFollowUps: Record<string, string> = {
  header: "Set the site name and logo with docs.site.name and docs.site.logo.",
  toc: "The outline has a fixed title. Hide it on one page with toc: false in the frontmatter.",
  docus: "@vite-hub/docs reads no docus app config.",
  assistant: "Turn the docs assistant on with docs.assistant.",
}

/** The `extends` entry of the Docus layer. */
function docusEntry(config: NuxtConfigFile): { property: Node, element?: Node, only: boolean } | undefined {
  const property = findProperty(config.root, "extends")
  if (!property) return undefined
  const value = unwrapExpression(property.value)
  if (literalValue(value) === layerName) return { property, only: true }
  if (value.type !== "ArrayExpression") return undefined
  const element = value.elements.find(entry => entry && literalValue(entry) === layerName)
  return element ? { property, element, only: value.elements.length === 1 } : undefined
}

function stringOption(object: ObjectExpression | undefined, name: string): string | undefined {
  const property = object && findProperty(object, name)
  const value = property && literalValue(property.value)
  return typeof value === "string" ? value : undefined
}

function assertStaticStrings(file: string, object: ObjectExpression, key: string, names: string[]): void {
  for (const child of object.properties) {
    const name = child.type === "ObjectProperty" ? keyName(child.key, child.computed) : undefined
    if (!name || (names.includes(name) && stringOption(object, name) === undefined)) {
      throw codemodError(`${file}:${line(child)}: Move the computed ${key}${name ? `.${name}` : ""} setting by hand.`)
    }
  }
}

interface DocsOptions {
  site: Record<string, string>
  github?: { repo: string, branch?: string, dir?: string }
  socials: Array<{ label: string, icon: string, to: string }>
}

function renderOptions(options: DocsOptions, style: CodeStyle, indent: string): string {
  const quote = (value: string) => quoteString(value, style)
  const inner = `${indent}${style.indent}`
  const lines = [`site: { ${Object.entries(options.site).map(([key, value]) => `${key}: ${quote(value)}`).join(", ")} },`]
  if (options.github) lines.push(`github: { ${Object.entries(options.github).map(([key, value]) => `${key}: ${quote(value)}`).join(", ")} },`)
  if (options.socials.length) {
    lines.push("socials: [", ...options.socials.map(social => `${style.indent}{ label: ${quote(social.label)}, icon: ${quote(social.icon)}, to: ${quote(social.to)} },`), "],")
  }
  return `docs: {\n${lines.map(text => `${inner}${text}`).join("\n")}\n${indent}}`
}

/** Reads the Docus keys of app.config and plans their removal. */
async function readAppConfig(cwd: string, options: DocsOptions, followUps: FollowUp[]): Promise<FileEdit | undefined> {
  const [file] = await glob(["app/app.config.{ts,mts,js,mjs}", "app.config.{ts,mts,js,mjs}"], { cwd })
  if (!file) return undefined
  const code = await readFile(join(cwd, file), "utf8")
  let program
  try {
    program = parseProgram(code, { typescript: !/\.m?js$/.test(file) })
  }
  catch {
    followUps.push({ file, message: "The codemod could not parse this app config. Move its seo, socials, and github keys to the docs options in nuxt.config by hand." })
    return undefined
  }
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  let value = exported?.type === "ExportDefaultDeclaration" ? unwrapExpression(exported.declaration) : undefined
  if (value?.type === "CallExpression" && value.arguments[0]) value = unwrapExpression(value.arguments[0])
  const root = value && staticOptionsObject(value)
  if (!root) {
    followUps.push({ file, message: "The app config is not an object literal. Move its seo, socials, and github keys to the docs options in nuxt.config by hand." })
    return undefined
  }
  const output = new MagicString(code)
  const githubProperty = findProperty(root, "github")
  const github = githubProperty && staticOptionsObject(githubProperty.value)
  const githubRepo = stringOption(github, "url")?.match(/^https?:\/\/github\.com\/([^/]+\/[^/#?]+)/)?.[1]?.replace(/\.git$/, "")
  let removed = 0
  for (const property of root.properties) {
    if (property.type !== "ObjectProperty") continue
    const key = keyName(property.key, property.computed)
    const object = staticOptionsObject(property.value)
    if (!object && (key === "seo" || key === "github" || key === "socials")) {
      throw codemodError(`${file}:${line(property)}: Move the computed ${key} setting by hand.`)
    }
    if (key === "seo" && object) {
      assertStaticStrings(file, object, key, ["title", "description"])
      const title = stringOption(object, "title")
      const description = stringOption(object, "description")
      if (title) options.site.name ??= title
      if (description) options.site.description ??= description
      for (const child of object.properties) {
        const name = child.type === "ObjectProperty" ? keyName(child.key, child.computed) : undefined
        if (name !== "title" && name !== "description") followUps.push({ file, line: line(child), message: `seo.${name ?? "..."}: set a page's share image with seo.image in its frontmatter. @vite-hub/docs renders one from the title and description otherwise.` })
      }
    }
    else if (key === "github" && object) {
      assertStaticStrings(file, object, key, ["url", "branch", "rootDir"])
      const repo = githubRepo
      if (!repo) {
        followUps.push({ file, line: line(property), message: "github.url is not a GitHub repository URL, so the codemod did not move it. Set docs.github.repo by hand." })
        continue
      }
      const branch = stringOption(object, "branch")
      const dir = stringOption(object, "rootDir")
      options.github = { repo, ...(branch ? { branch } : {}), ...(dir ? { dir } : {}) }
    }
    else if (key === "socials" && object) {
      assertStaticStrings(file, object, key, object.properties.flatMap(child => child.type === "ObjectProperty" ? [keyName(child.key, child.computed) ?? ""] : []))
      for (const child of object.properties) {
        const name = child.type === "ObjectProperty" ? keyName(child.key, child.computed) : undefined
        const to = child.type === "ObjectProperty" ? literalValue(child.value) : undefined
        // The GitHub link comes from docs.github.
        if (name === "github" && githubRepo && (to === githubRepo || to === `https://github.com/${githubRepo}`)) continue
        const url = name === "github" && typeof to === "string" && /^[\w.-]+\/[\w.-]+$/.test(to) ? `https://github.com/${to}` : to
        if (!name || typeof url !== "string" || !/^https?:\/\//.test(url)) {
          throw codemodError(`${file}:${line(child)}: Move the ${name ?? "unknown"} entry to docs.socials by hand.`)
        }
        options.socials.push({ label: name === "x" ? "X" : name.replace(/^\w/, letter => letter.toUpperCase()), icon: `i-simple-icons-${name}`, to: url })
      }
    }
    else {
      const message = key && appConfigFollowUps[key]
      if (message) followUps.push({ file, line: line(property), message: `${key}: ${message}` })
      continue
    }
    output.remove(...listItemRemoval(code, property))
    removed++
  }
  const after = output.toString().replace(/\{\s*\n(\s*\n)+/, "{\n").replace(/\n(\s*\n)+(\s*\})/, "\n$2")
  if (removed === root.properties.length) return { path: file, before: code, after: null }
  return removed ? { path: file, before: code, after } : undefined
}

async function assertContentDestinations(cwd: string, edits: FileEdit[]): Promise<void> {
  const created = new Set<string>()
  for (const edit of edits) {
    if (edit.before !== undefined || edit.after === null) continue
    if (created.has(edit.path)) throw codemodError(`${edit.path}: Multiple edits have the same destination.`)
    created.add(edit.path)
  }
  for (const destination of created) {
    for (let path = destination; path !== "."; path = posix.dirname(path)) {
      if (path !== destination && created.has(path)) throw codemodError(`${destination}: Destination ancestor ${path} is also a planned file.`)
      const entry = await lstat(join(cwd, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
        return undefined
      })
      if (entry && (path === destination || !entry.isDirectory())) {
        throw codemodError(`${destination}: ${path} is occupied. Move it before migrating.`)
      }
    }
  }
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const config = await readNuxtConfig(cwd)
  const entry = docusEntry(config)
  if (!entry) throw codemodError(`${config.fileName} does not extend the docus layer. Docus apps write extends: ['docus'].`)
  const followUps: FollowUp[] = []
  const edits: FileEdit[] = []
  const editor = new ConfigEditor(config)
  const style = editor.style
  const removed = new Set<Node>()
  if (entry.only) {
    editor.removeItem(entry.property)
    removed.add(entry.property)
  }
  else editor.removeItem(entry.element!)

  // Site options.
  const options: DocsOptions = { site: {}, socials: [] }
  const site = findProperty(config.root, "site")
  const siteObject = site && staticOptionsObject(site.value)
  if (site && !siteObject) throw codemodError(`${config.fileName}:${line(site)}: Move the computed site setting by hand.`)
  if (siteObject) {
    assertStaticStrings(config.fileName, siteObject, "site", ["name", "url", "description"])
    for (const name of ["name", "url", "description"]) {
      const value = stringOption(siteObject, name)
      if (value) options.site[name] = value
    }
    if (siteObject.properties.every(property => property.type === "ObjectProperty" && ["name", "url", "description"].includes(keyName(property.key, property.computed) ?? ""))) {
      editor.removeItem(site)
      removed.add(site)
    }
  }
  const llms = findProperty(config.root, "llms")
  const llmsObject = llms && staticOptionsObject(llms.value)
  if (llms && !llmsObject) throw codemodError(`${config.fileName}:${line(llms)}: Move the computed llms setting by hand.`)
  if (llms && llmsObject) {
    assertStaticStrings(config.fileName, llmsObject, "llms", ["domain"])
    const domain = stringOption(llmsObject, "domain")
    if (domain) options.site.url ??= domain
    const other = llmsObject.properties.filter(property => property.type !== "ObjectProperty" || keyName(property.key, property.computed) !== "domain")
    if (other.length) followUps.push({ file: config.fileName, line: line(llms), message: "@vite-hub/docs writes /llms.txt from the pages. Move extra llms.txt text to docs.llms.details or docs.llms.sections." })
    editor.removeItem(llms)
    removed.add(llms)
  }
  for (const name of ["content", "mcp"]) {
    const property = findProperty(config.root, name)
    if (property) followUps.push({ file: config.fileName, line: line(property), message: `${name}: these were options of the Docus modules. @vite-hub/docs ${name === "mcp" ? "serves its MCP server at /mcp; set docs.mcp to change it" : "reads Markdown with Comark; set docs.parser for plugins"}. Remove the key when nothing else reads it.` })
  }
  const appConfig = await readAppConfig(cwd, options, followUps)
  if (appConfig) edits.push(appConfig)
  if (!options.site.name) {
    options.site.name = "Docs"
    followUps.push({ file: config.fileName, message: "The codemod found no site name, so it set docs.site.name to \"Docs\". Change it." })
  }
  if (findProperty(config.root, "docs")) throw codemodError(`${config.fileName} already sets docs. Merge the @vite-hub/docs options by hand.`)

  // Module and options.
  const rootEntries: string[] = []
  const modules = objectPropertyArray(config.root, "modules")
  const moduleText = quoteString(docsModule, style)
  const contentModule = findModuleEntry(config, "@nuxt/content")
  if (contentModule?.inlineOptions || findProperty(config.root, "content")) {
    throw codemodError(`${config.fileName}: Migrate the custom Nuxt Content options by hand; the codemod cannot verify the published page set.`)
  }
  if (contentModule) {
    editor.output.overwrite(start(contentModule.element), end(contentModule.element), moduleText)
  }
  else if (modules) {
    const last = modules.elements.at(-1)
    if (last) editor.output.appendLeft(end(last), `, ${moduleText}`)
    else editor.output.appendLeft(end(modules) - 1, moduleText)
  }
  else if (findProperty(config.root, "modules")) throw codemodError(`${config.fileName} sets modules to an expression. Make it an array literal, then run the codemod again.`)
  else rootEntries.push(`modules: [${moduleText}]`)
  const indent = editor.propertyIndent(config.root)
  rootEntries.push(renderOptions(options, style, indent))
  editor.insertProperties(config.root, rootEntries, removed)
  const configAfter = editor.output.toString()
  assertModuleRemoved(config.fileName, configAfter, layerName, "@nuxt/content")
  edits.unshift({ path: config.fileName, before: config.code, after: configAfter })

  // Content.
  const contentDir = "content"
  if (!existsSync(join(cwd, contentDir))) throw codemodError(`${contentDir}/ does not exist. Docus reads its pages from content/.`)
  const [customConfig] = await glob(["content.config.*", "app/content.config.*"], { cwd })
  if (customConfig) throw codemodError(`${customConfig}: Migrate custom Docus collections by hand; the codemod cannot verify the published page set.`)
  const files = (await glob(["**/*.md", "**/.navigation.yml"], { cwd: join(cwd, contentDir), dot: true }))
    .filter(file => file.endsWith(".md") || posix.basename(file) === ".navigation.yml").sort()
  const scoped = existsSync(join(cwd, contentDir, "docs"))
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    if ((scoped && file !== "index.md" && !file.startsWith("docs/")) || file.split("/").some(segment => segment.startsWith("."))) {
      throw codemodError(`${contentDir}/${file}: Docs could publish this file outside the original Docus collections. Move it out of content/ before migrating.`)
    }
  }
  const targets = new Map<string, string>()
  const routes = new Set<string>()
  const destinations = new Map<string, string>()
  for (const file of files) {
    const target = file.split("/").map((segment, index, segments) => {
      if (segment === ".navigation.yml") return segment
      const extension = index === segments.length - 1 ? ".md" : ""
      const name = stripOrder(extension ? segment.slice(0, -extension.length) : segment).name
      if (!/^(?:[a-z\d]+(?:-[a-z\d]+)*|v?\d+(?:\.\d+)+)$/.test(name)) {
        throw codemodError(`${contentDir}/${file}: Rename this page or folder to its existing Docus URL slug before migrating.`)
      }
      return name + extension
    }).join("/")
    const existing = targets.get(target)
    if (existing) throw codemodError(`${contentDir}/${file} and ${contentDir}/${existing} have the same destination ${contentDir}/${target}. Rename one before migrating.`)
    targets.set(target, file)
    destinations.set(file, target)
    if (target.endsWith(".md")) {
      const route = target.slice(0, -3).replace(/(^|\/)index$/, "").replace(/\/$/, "")
      if (routes.has(route)) throw codemodError(`${contentDir}/${file}: Multiple pages resolve to /${route}. Rename one before migrating.`)
      routes.add(route)
    }
  }
  // Each numbered folder gets its order in `.navigation.yml`.
  const folders = new Map<string, number>()
  for (const file of files) {
    const segments = file.split("/").slice(0, -1)
    segments.forEach((segment, index) => {
      const { order } = stripOrder(segment)
      if (order !== undefined) folders.set(segments.slice(0, index + 1).join("/"), order)
    })
  }
  let pages = 0
  for (const file of files) {
    const source = posix.join(contentDir, file)
    const target = posix.join(contentDir, destinations.get(file)!)
    const before = await readFile(join(cwd, source), "utf8")
    const name = file.split("/").at(-1)!
    let result
    if (name === ".navigation.yml") {
      const folder = file.split("/").slice(0, -1).join("/")
      result = moveSection(source, before, folders.get(folder))
      folders.delete(folder)
    }
    else {
      const { order } = stripOrder(name.replace(/\.md$/, ""))
      result = movePage(source, before, name.startsWith("index.") ? undefined : order)
      pages++
    }
    followUps.push(...result?.followUps ?? [])
    const after = result?.code ?? null
    if (target === source) {
      if (after !== before) edits.push({ path: source, before, after })
    }
    else {
      edits.push({ path: source, before, after: null })
      if (after !== null) edits.push({ path: target, before: undefined, after })
    }
  }
  for (const [folder, order] of folders) {
    const target = posix.join(contentDir, folder.split("/").map(segment => stripOrder(segment).name).join("/"), ".navigation.yml")
    edits.push({ path: target, before: undefined, after: moveSection(target, undefined, order)!.code })
  }
  await assertContentDestinations(cwd, edits)
  for (const file of (await glob(["app/components/content/**/*.vue", "components/content/**/*.vue"], { cwd })).sort()) {
    followUps.push({ file, message: "Docus rendered this component from Markdown. Give @vite-hub/docs a component map with docs.components, so pages that use it keep rendering it." })
  }

  const packageResult = await editPackageJson(cwd, packageJson.version, { remove: [layerName, "@nuxt/content", "better-sqlite3"], add: ["@vite-hub/docs"], within: docsPeers })
  if (packageResult.edit) edits.push(packageResult.edit)
  return {
    summary: `moved the site from the docus layer to ${docsModule} and ${pages} page${pages === 1 ? "" : "s"} to its frontmatter.`,
    edits,
    followUps,
    notes: [
      "Page URLs stay the same: Nuxt Content dropped the order prefixes of file names, and @vite-hub/docs reads the order from navigation.order and .navigation.yml.",
      "Without a content/docs/ folder, the docs are the whole site: content/index.md is /, and each folder in content/ is a section.",
      `@vite-hub/docs renders GitHub callouts, ::note, ::tip, ::warning, ::caution, tabs, code groups, steps, and cards with comark-ui. See ${guide}.`,
    ],
    nextSteps: [
      `Run \`${packageResult.installCommand}\` to install @vite-hub/docs and remove docus.`,
      "Run `npx nuxi dev` and open each section. A wrong frontmatter field stops the build with DOCS_CONTENT_INVALID.",
    ],
  }
}

/** Detects `extends: ['docus']` in nuxt.config, or a `docus` dependency. */
async function detect({ cwd }: CodemodContext) {
  try {
    const config = await readNuxtConfig(cwd)
    if (docusEntry(config)) return { reason: `${config.fileName} extends the docus layer` }
  }
  catch (error) {
    if (!isCodemodError(error)) throw error
  }
  if ((await readDependencies(cwd)).has(layerName)) return { reason: `package.json depends on ${layerName}` }
  return undefined
}

export const docus: Codemod = {
  name: "docus",
  description: "Move a Docus site to @vite-hub/docs: the module, the site options, and the page frontmatter.",
  usage: "[dir]",
  detect,
  run: migrate,
}
