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

/** Driver names accepted by the old Workspace Store options. */
const workspaceStoreDrivers = new Set(["local", "memory", "github", "cloudflare-artifacts", "vercel-blob"])

type Api = Feature | "browser" | "workspace" | "config"

/** Match both the exported name and the module that owns the API. */
const apiCalls = new Map<string, { kind: Api, sources: readonly string[] }>([
  ["createBrowser", { kind: "browser", sources: ["@vite-hub/browser", "vite-hub/browser"] }],
  ["createEmail", { kind: "email", sources: ["@vite-hub/email", "vite-hub/email"] }],
  ["createQueueClient", { kind: "queue", sources: ["@vite-hub/queue", "vite-hub/queue"] }],
  ["defineWorkspace", { kind: "workspace", sources: ["@vite-hub/workspace", "vite-hub/workspace"] }],
  ["hubWorkspace", { kind: "workspace", sources: ["@vite-hub/workspace/vite", "vite-hub/workspace/vite"] }],
  ["hubBlob", { kind: "blob", sources: ["@vite-hub/blob/vite", "vite-hub/blob/vite"] }],
  ["hubDb", { kind: "database", sources: ["@vite-hub/database/vite", "vite-hub/database/vite"] }],
  ["hubEmail", { kind: "email", sources: ["@vite-hub/email/vite", "vite-hub/email/vite"] }],
  ["hubKv", { kind: "kv", sources: ["@vite-hub/kv/vite", "vite-hub/kv/vite"] }],
  ["hubQueue", { kind: "queue", sources: ["@vite-hub/queue/vite", "vite-hub/queue/vite"] }],
  ["hubRateLimit", { kind: "rateLimit", sources: ["@vite-hub/rate-limit/vite", "vite-hub/rate-limit/vite"] }],
  ["hubRealtime", { kind: "realtime", sources: ["@vite-hub/realtime/vite", "vite-hub/realtime/vite"] }],
  ["hubSandboxTask", { kind: "sandboxTask", sources: ["@vite-hub/sandbox/task/vite", "vite-hub/sandbox/task/vite"] }],
  ["hubWorkflow", { kind: "workflow", sources: ["@vite-hub/workflow/vite", "vite-hub/workflow/vite"] }],
  ["vitehub", { kind: "config", sources: ["vite-hub"] }],
  ["defineConfig", { kind: "config", sources: ["vite", "vite-plus", "nitro/config"] }],
  ["defineNuxtConfig", { kind: "config", sources: ["nuxt/config"] }],
  ["defineNitroConfig", { kind: "config", sources: ["nitro/config"] }],
])

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

function resolveApis(program: File) {
  const declarations = new Map<string, number>()
  const imports = new Map<string, { source: string, name?: string }>()
  const add = (node: Node | null | undefined): void => {
    if (!node) return
    if (node.type === "Identifier") declarations.set(node.name, (declarations.get(node.name) ?? 0) + 1)
    else if (node.type === "RestElement") add(node.argument)
    else if (node.type === "AssignmentPattern") add(node.left)
    else if (node.type === "ArrayPattern") node.elements.forEach(add)
    else if (node.type === "ObjectPattern") node.properties.forEach(property => add(property.type === "RestElement" ? property.argument : property.value))
    else if (node.type === "TSParameterProperty") add(node.parameter)
  }
  walk(program, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        add(specifier.local)
        if (node.importKind === "type" || specifier.type === "ImportDefaultSpecifier") continue
        if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
          imports.set(specifier.local.name, { source: node.source.value, name: keyName(specifier.imported) })
        }
        else if (specifier.type === "ImportNamespaceSpecifier") imports.set(specifier.local.name, { source: node.source.value })
      }
    }
    else if (node.type === "VariableDeclarator") add(node.id)
    else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression"
      || node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod" || node.type === "TSDeclareFunction") {
      if ("id" in node) add(node.id)
      node.params.forEach(add)
    }
    else if (node.type === "ClassDeclaration" || node.type === "ClassExpression" || node.type === "TSEnumDeclaration" || node.type === "TSImportEqualsDeclaration") add(node.id)
    else if (node.type === "CatchClause") add(node.param)
  })

  return (callee: Node, implicitConfig?: string): Api | undefined => {
    const local = callee.type === "Identifier" ? callee.name
      : callee.type === "MemberExpression" && callee.object.type === "Identifier" ? callee.object.name : undefined
    if (!local) return undefined
    const binding = imports.get(local)
    // A second declaration can shadow the import. Leave this name unchanged throughout the file.
    if (!binding) return callee.type === "Identifier" && local === implicitConfig && !declarations.has(local) ? "config" : undefined
    if (declarations.get(local) !== 1) return undefined
    const name = callee.type === "Identifier" ? binding.name
      : callee.type === "MemberExpression" && !binding.name ? keyName(callee.property, callee.computed) : undefined
    const api = name ? apiCalls.get(name) : undefined
    return api?.sources.includes(binding.source) ? api.kind : undefined
  }
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

function rewriteWorkspace(context: FileContext, object: ObjectExpression) {
  for (const property of objectProperties(object)) {
    if (propertyName(property) === "store" && property.value.type === "ObjectExpression") rewriteWorkspaceStore(context, property.value)
  }
}

function rewriteConfig(context: FileContext, object: ObjectExpression) {
  for (const property of objectProperties(object)) {
    const name = propertyName(property)
    if (!name || property.value.type !== "ObjectExpression") continue
    if (name === "vitehub") rewriteConfig(context, property.value)
    else if (name === "workspace") rewriteWorkspace(context, property.value)
    else if (name !== "store" && (isKeyFeature(name) || isValueFeature(name))) rewriteFeature(context, name, property.value)
  }
}

function rewriteProgram(context: FileContext, program: File) {
  const resolveApi = resolveApis(program)
  const fileName = basename(context.file)
  const implicitConfig = fileName.startsWith("nuxt.config.") ? "defineNuxtConfig" : fileName.startsWith("nitro.config.") ? "defineNitroConfig" : undefined
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (node.type === "ExportDefaultDeclaration" && node.declaration.type === "ObjectExpression" && configFile.test(fileName)) {
      rewriteConfig(context, node.declaration)
      return
    }
    if (node.type !== "CallExpression") return
    const api = resolveApi(node.callee, parent?.type === "ExportDefaultDeclaration" ? implicitConfig : undefined)
    const options = node.arguments[0]
    if (!api || options?.type !== "ObjectExpression") return
    if (api === "config") rewriteConfig(context, options)
    else if (api === "workspace") rewriteWorkspace(context, options)
    else rewriteFeature(context, api, options)
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
    rewriteProgram(context, program)
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
  // This upgrade runs by name; it does not migrate a third-party module.
  detect: async () => undefined,
  run: migrate,
}
