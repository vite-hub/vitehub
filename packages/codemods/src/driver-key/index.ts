import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { detectStyle, end, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import type { File, ObjectExpression, ObjectProperty } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** The old key that picked the backend of a feature. The new key is always `driver`. */
const renamedKeys = {
  queue: "provider",
  rateLimit: "provider",
  realtime: "authority",
  sandboxTask: "provider",
  workflow: "provider",
} as const

/** Driver values that now name the host. A value that is not listed stays. */
const renamedValues = {
  blob: { "cloudflare-r2": "cloudflare", "vercel-blob": "vercel" },
  cache: { "cloudflare-kv-binding": "cloudflare", "vercel-runtime-cache": "vercel" },
  database: { d1: "cloudflare" },
  email: { "cloudflare-email": "cloudflare" },
  kv: { "cloudflare-kv-binding": "cloudflare" },
  store: { "cloudflare-artifacts": "cloudflare", "vercel-blob": "vercel" },
} as const satisfies Record<string, Record<string, string>>

type KeyFeature = keyof typeof renamedKeys
type ValueFeature = keyof typeof renamedValues
type Feature = KeyFeature | ValueFeature

/** Workspace Store drivers. A `store` object with one of these `provider` values is a Workspace Store. */
const workspaceStoreDrivers = new Set(["local", "memory", "github", "cloudflare-artifacts", "vercel-blob"])

/** Functions whose first argument is the options object of one feature. */
const featureCalls = new Map<string, Feature | "browser">([
  ["createBrowser", "browser"],
  ["createEmail", "email"],
  ["createQueueClient", "queue"],
  ["hubBlob", "blob"],
  ["hubDb", "database"],
  ["hubEmail", "email"],
  ["hubKv", "kv"],
  ["hubQueue", "queue"],
  ["hubRateLimit", "rateLimit"],
  ["hubRealtime", "realtime"],
  ["hubSandboxTask", "sandboxTask"],
  ["hubWorkflow", "workflow"],
])

/** Calls whose first argument is a config root that holds feature keys, such as `vitehub({ queue: ... })`. */
const configCalls = new Set(["defineConfig", "defineNuxtConfig", "defineNitroConfig", "vitehub"])

const configFile = /^(?:vite|nuxt|nitro)\.config\.[cm]?[jt]s$/
const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needles = ["provider", "authority", ...Object.values(renamedValues).flatMap(values => Object.keys(values))]

interface FileContext {
  file: string
  followUps: FollowUp[]
  output: MagicString
  style: CodeStyle
  changed: boolean
}

function isKeyFeature(feature: string): feature is KeyFeature {
  return Object.hasOwn(renamedKeys, feature)
}

function isValueFeature(feature: string): feature is ValueFeature {
  return Object.hasOwn(renamedValues, feature)
}

function propertyName(property: ObjectProperty): string | undefined {
  return keyName(property.key, property.computed)
}

function objectProperties(object: ObjectExpression): ObjectProperty[] {
  return object.properties.filter((property): property is ObjectProperty => property.type === "ObjectProperty")
}

function calleeName(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") return node.property.name
  return undefined
}

/** Renames the key of `property` to `driver`. A shorthand `{ provider }` becomes `{ driver: provider }`. */
function renameKey(context: FileContext, property: ObjectProperty) {
  if (property.shorthand) context.output.appendLeft(start(property), "driver: ")
  else context.output.overwrite(start(property.key), end(property.key), "driver")
  context.changed = true
}

function renameValue(context: FileContext, property: ObjectProperty, values: Readonly<Record<string, string>>, label: string) {
  const value = property.value
  if (value.type === "StringLiteral") {
    const next = Object.hasOwn(values, value.value) ? values[value.value] : undefined
    if (!next) return
    context.output.overwrite(start(value), end(value), quoteString(next, context.style))
    context.changed = true
    return
  }
  const renamed = Object.entries(values).map(([from, to]) => `"${from}" is now "${to}"`).join(", ")
  context.followUps.push({ file: context.file, line: line(property), message: `\`${label}\` is not a string literal. Check its value: ${renamed}.` })
}

/** Rewrites the options object of one feature: the old key becomes `driver`, and old driver values get the new name. */
function rewriteFeature(context: FileContext, feature: Feature | "browser", object: ObjectExpression) {
  const properties = objectProperties(object)
  if (feature === "browser" || isKeyFeature(feature)) {
    const oldKey = feature === "browser" ? "provider" : renamedKeys[feature]
    const property = properties.find(entry => propertyName(entry) === oldKey)
    if (!property) return
    if (properties.some(entry => propertyName(entry) === "driver")) {
      context.followUps.push({ file: context.file, line: line(property), message: `\`${feature}\` sets both \`${oldKey}\` and \`driver\`. Keep one \`driver\`.` })
      return
    }
    renameKey(context, property)
    return
  }
  for (const property of properties) {
    const name = propertyName(property)
    if (name === "driver") renameValue(context, property, renamedValues[feature], `${feature}.driver`)
    // Blob and KV stores each select their own driver.
    if (name === "stores" && (feature === "blob" || feature === "kv") && property.value.type === "ObjectExpression") {
      for (const store of objectProperties(property.value)) {
        if (store.value.type === "ObjectExpression") rewriteFeature(context, feature, store.value)
      }
    }
  }
}

/** A `store: { provider: "memory" }` object of a Workspace: `provider` becomes `driver`, and the host values get the host name. */
function rewriteWorkspaceStore(context: FileContext, object: ObjectExpression) {
  const properties = objectProperties(object)
  const provider = properties.find(entry => propertyName(entry) === "provider")
  if (!provider || provider.value.type !== "StringLiteral" || !workspaceStoreDrivers.has(provider.value.value)) return
  if (properties.some(entry => propertyName(entry) === "driver")) return
  renameKey(context, provider)
  renameValue(context, provider, renamedValues.store, "store.driver")
}

/** True when `object` is a config root: the argument of `vitehub()` or `defineConfig()`, `vitehub` in Nuxt config, or the default export. */
function isConfigRoot(object: ObjectExpression, parent: Node | undefined): boolean {
  if (!parent) return false
  if (parent.type === "CallExpression") {
    const name = calleeName(parent.callee)
    return Boolean(name && configCalls.has(name) && parent.arguments[0] === object)
  }
  if (parent.type === "ObjectProperty") return keyName(parent.key, parent.computed) === "vitehub" && parent.value === object
  return parent.type === "ExportDefaultDeclaration"
}

function rewriteProgram(context: FileContext, program: File, isConfig: boolean) {
  walk(program, (node, ancestors) => {
    if (node.type === "CallExpression") {
      const name = calleeName(node.callee)
      const feature = name ? featureCalls.get(name) : undefined
      const options = node.arguments[0]
      if (feature && options?.type === "ObjectExpression") rewriteFeature(context, feature, options)
      return
    }
    if (node.type !== "ObjectExpression") return
    const parent = ancestors.at(-1)
    if (parent?.type === "ObjectProperty" && parent.value === node && keyName(parent.key, parent.computed) === "store") rewriteWorkspaceStore(context, node)
    if (!isConfig || !isConfigRoot(node, parent)) return
    for (const property of objectProperties(node)) {
      const name = propertyName(property)
      if (!name || property.value.type !== "ObjectExpression") continue
      if (name !== "store" && (isKeyFeature(name) || isValueFeature(name))) rewriteFeature(context, name, property.value)
    }
  })
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []

  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!needles.some(needle => source.includes(needle))) continue
    let program: File
    try {
      program = parseProgram(source, { jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) })
    }
    catch (error) {
      followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Rename its backend keys to \`driver\` by hand.` })
      continue
    }
    const context: FileContext = { changed: false, file, followUps, output: new MagicString(source), style: detectStyle(source, program) }
    rewriteProgram(context, program, configFile.test(basename(file)))
    if (context.changed) edits.push({ path: file, before: source, after: context.output.toString() })
  }

  return {
    summary: edits.length ? `renamed the backend keys and driver values of ${edits.length} file(s) to \`driver\`` : "found no backend key to rename",
    edits,
    followUps,
    notes: edits.length ? ["Config that a variable or a helper function builds is not rewritten. Search for `provider` and `authority` next to `queue`, `workflow`, `rateLimit`, `realtime`, `sandboxTask`, and Workspace `store` options."] : [],
    nextSteps: edits.length ? ["Run your typecheck. The option types reject the old keys and values."] : [],
  }
}

export const driverKey: Codemod = {
  name: "driver-key",
  description: "Rename provider and authority options to driver, and name host drivers cloudflare and vercel",
  usage: "[dir]",
  run: migrate,
}
