import { basename } from "node:path"

import { end, findProperty, indentAt, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"

import { ConfigEditor, findViteHubEntry } from "../shared/config-editor.ts"
import { blockBindings } from "../shared/bindings.ts"
import { unwrapExpression } from "../shared/nuxt-config.ts"

import type { File, Node, ObjectExpression, ObjectProperty } from "@babel/types"
import type { FollowUp } from "../types.ts"

/** Top-level Vite keys that owner plugins read before `vitehub()` became the only config place. */
const removedViteKeys = ["agent", "auth", "blob", "browser", "database", "kv", "queue", "rateLimit", "sandboxTask", "vitehub", "workflow", "workspace"]

/** The standalone plugin that takes the options of each key as its argument. */
const ownerPlugins: Record<string, { name: string, package: string }> = {
  agent: { name: "hubAgent", package: "agent" },
  auth: { name: "hubAuth", package: "auth" },
  blob: { name: "hubBlob", package: "blob" },
  browser: { name: "hubBrowser", package: "browser" },
  database: { name: "hubDb", package: "database" },
  kv: { name: "hubKv", package: "kv" },
  queue: { name: "hubQueue", package: "queue" },
  rateLimit: { name: "hubRateLimit", package: "rate-limit" },
  sandboxTask: { name: "hubSandboxTask", package: "sandbox/task" },
  workflow: { name: "hubWorkflow", package: "workflow" },
  workspace: { name: "hubWorkspace", package: "workspace" },
}

const configFunctions = new Set(["defineConfig", "defineNuxtConfig"])

export interface OptionsMigration {
  code: string
  changed: boolean
  followUps: FollowUp[]
  notes: string[]
}

/** The object of `defineConfig({...})`, `defineConfig(() => ({...}))`, `defineNuxtConfig({...})`, or `export default {...}`. */
function findConfigRoot(program: File): ObjectExpression | undefined {
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  if (!exported) return undefined
  let value = unwrapExpression(exported.declaration)
  if (value.type === "Identifier") {
    const name = value.name
    for (const statement of program.program.body) {
      if (statement.type !== "VariableDeclaration") continue
      for (const declarator of statement.declarations) {
        if (declarator.id.type === "Identifier" && declarator.id.name === name && declarator.init) value = unwrapExpression(declarator.init)
      }
    }
  }
  if (value.type === "CallExpression") {
    // Only a config: `export default defineAgent({...})` is not one.
    if (value.callee.type !== "Identifier" || !configFunctions.has(value.callee.name)) return undefined
    const [argument] = value.arguments
    if (!argument) return undefined
    value = unwrapExpression(argument)
  }
  if (value.type === "ArrowFunctionExpression" && value.body.type !== "BlockStatement") value = unwrapExpression(value.body)
  return value.type === "ObjectExpression" ? value : undefined
}

function property(object: ObjectExpression, name: string): ObjectProperty | undefined {
  return findProperty(object, name)
}

function objectValue(node: Node | undefined): ObjectExpression | undefined {
  const value = node ? unwrapExpression(node) : undefined
  return value?.type === "ObjectExpression" ? value : undefined
}

/** Verified, unshadowed value imports of the expected API. Ambiguous bindings stay unchanged. */
function importedNames(program: File, sources: readonly string[], imported: string): Set<string> {
  const names = new Set<string>()
  const bindings = blockBindings(program)
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !sources.includes(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && keyName(specifier.imported) === imported
        && bindings.get(specifier.local.name)?.every(binding => binding === specifier.local)) names.add(specifier.local.name)
    }
  }
  return names
}

function callsOf(scope: Node, names: ReadonlySet<string>): Array<Node & { type: "CallExpression" }> {
  const calls: Array<Node & { type: "CallExpression" }> = []
  walk(scope, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && names.has(node.callee.name)) calls.push(node)
  })
  return calls
}

/** Moves the lines of `text` after the first from the indentation `from` to `to`. */
function reindent(text: string, from: string, to: string): string {
  if (from === to) return text
  return text.split("\n").map((value, index) => {
    if (index === 0 || !value.trim()) return value
    if (value.startsWith(from)) return to + value.slice(from.length)
    return to.length > from.length ? to.slice(from.length) + value : value
  }).join("\n")
}

/**
 * Moves the vite-hub options of a config file. `findRoots` selects other config objects, such as the inline configs of
 * a test file. Without it, the file's default export is the config.
 */
export function migrateViteHubOptions(file: string, code: string, findRoots?: (program: File) => ObjectExpression[]): OptionsMigration {
  const followUps: FollowUp[] = []
  const notes: string[] = []
  const unchanged = { code, changed: false, followUps, notes }
  if (!code.includes("vite-hub") && !code.includes("hubEnv")) return unchanged
  let program: File
  try {
    program = parseProgram(code)
  }
  catch {
    return unchanged
  }
  const defaultRoot = findConfigRoot(program)
  const roots = findRoots ? findRoots(program) : defaultRoot ? [defaultRoot] : []
  if (!roots[0]) return unchanged
  const nuxt = basename(file).startsWith("nuxt.config")
  const editor = new ConfigEditor({ code, fileName: file, path: file, program, root: roots[0] })
  const removed = new Set<Node>()
  let changed = false
  const text = (node: Node) => code.slice(start(node), end(node))
  const follow = (node: Node, message: string) => followUps.push({ file, line: line(node), message })
  const remove = (node: Node) => {
    editor.removeItem(node)
    removed.add(node)
    changed = true
  }

  for (const root of roots) {
  // The options objects of `vitehub()` in a Vite config, or of `vite-hub/nuxt` in a Nuxt config.
  const optionObjects: ObjectExpression[] = []
  const emptyCalls: Array<Node & { type: "CallExpression" }> = []
  if (nuxt) {
    const key = objectValue(property(root, "vitehub")?.value)
    if (key) optionObjects.push(key)
    const entry = findViteHubEntry({ code, fileName: file, path: file, program, root })
    const inline = entry?.type === "ArrayExpression" ? objectValue(entry.elements[1] ?? undefined) : undefined
    if (inline) optionObjects.push(inline)
  }
  else {
    const names = importedNames(program, ["vite-hub"], "vitehub")
    const local = callsOf(root, names)
    for (const call of local.length || findRoots ? local : callsOf(program, names)) {
      const [argument] = call.arguments
      const options = objectValue(argument)
      if (options) optionObjects.push(options)
      else if (!argument) emptyCalls.push(call)
    }
  }

  for (const options of optionObjects) {
    const contentImportBase = property(options, "contentImportBase")
    if (contentImportBase) {
      remove(contentImportBase)
      notes.push(`${file}: removed contentImportBase. ViteHub always imports Content from vite-hub/content.`)
    }
    const logs = property(options, "logs")
    if (!logs) continue
    const logsValue = unwrapExpression(logs.value)
    if (logsValue.type === "BooleanLiteral" && !logsValue.value) {
      remove(logs)
      continue
    }
    const observability = property(options, "observability")
    const observabilityValue = observability ? unwrapExpression(observability.value) : undefined
    const observabilityObject = objectValue(observability?.value)
    const logsObject = objectValue(logs.value)
    const evlog = logsObject ? property(logsObject, "evlog") : undefined
    if (evlog && observabilityObject && property(observabilityObject, "evlog")) {
      follow(logs, "Both logs.evlog and observability.evlog are set. Merge logs.evlog into observability.evlog, then move logs into observability.logs.")
      continue
    }
    if (observabilityObject && property(observabilityObject, "logs")) {
      follow(logs, "observability.logs is already set. Merge the logs option into it by hand.")
      continue
    }
    if (!logsObject && logsValue.type !== "BooleanLiteral") {
      follow(logs, "logs is an expression, so the codemod cannot move it. Move it into observability.logs by hand, and move any evlog options in it to observability.evlog.")
      continue
    }
    // `logs.evlog` becomes `observability.evlog`. The other `logs` options stay under `observability.logs`.
    const rest = logsObject?.properties.filter(item => item !== evlog) ?? []
    const logsText = !evlog ? text(logs.value) : rest.length ? `{ ${rest.map(text).join(", ")} }` : "true"
    const entries = [...(evlog ? [text(evlog)] : []), `logs: ${logsText}`]
    if (!observability) {
      editor.output.overwrite(start(logs), end(logs), `observability: { ${entries.join(", ")} }`)
      changed = true
    }
    else if (observabilityObject) {
      editor.insertProperties(observabilityObject, entries, new Set())
      remove(logs)
    }
    else if (observabilityValue?.type === "BooleanLiteral" && observabilityValue.value) {
      editor.output.overwrite(start(observabilityValue), end(observabilityValue), `{ ${entries.join(", ")} }`)
      remove(logs)
    }
    else {
      follow(logs, "observability is not an object literal. Move logs into observability.logs by hand.")
    }
  }

  // Env declarations: the top-level Vite `env` key, or `vite.env` in a Nuxt config, move into the Env options.
  const viteObject = nuxt ? objectValue(property(root, "vite")?.value) : root
  const envProperty = viteObject ? property(viteObject, "env") : undefined
  if (envProperty && viteObject) {
    const envValue = unwrapExpression(envProperty.value)
    const envText = text(envValue)
    const sourceIndent = indentAt(code, start(envProperty))
    const hubEnvNames = importedNames(program, ["@vite-hub/env/vite", "vite-hub/env/vite"], "hubEnv")
    const localHubEnvCalls = callsOf(root, hubEnvNames)
    const hubEnvCalls = nuxt ? [] : localHubEnvCalls.length || findRoots ? localHubEnvCalls : callsOf(program, hubEnvNames)
    const viteHubTargets = optionObjects.length + emptyCalls.length
    const moveInto = (target: ObjectExpression, nested: boolean): boolean => {
      const targetEnv = nested ? property(target, "env") : undefined
      if (nested && !targetEnv) {
        const indent = editor.propertyIndent(target)
        editor.insertProperties(target, [`env: ${reindent(envText, sourceIndent, indent)}`], removed)
        return true
      }
      const envOptions = nested ? objectValue(targetEnv!.value) : target
      if (!envOptions) {
        follow(envProperty, nested
          ? "The Env option of vitehub() is not an object literal. Move these declarations into vitehub({ env }) by hand."
          : "hubEnv() options are not an object literal. Move these declarations into hubEnv() by hand.")
        return false
      }
      const indent = editor.propertyIndent(envOptions)
      if (envValue.type !== "ObjectExpression") {
        editor.insertProperties(envOptions, [`...${reindent(envText, sourceIndent, indent)}`], removed)
        return true
      }
      const conflict = envValue.properties.find(item => item.type === "ObjectProperty" && property(envOptions, keyName(item.key, item.computed) ?? ""))
      if (conflict) {
        follow(envProperty, `env.${keyName((conflict as ObjectProperty).key) ?? ""} is set in two places. Merge the declarations into one object by hand.`)
        return false
      }
      const propertyIndent = envValue.properties[0] ? indentAt(code, start(envValue.properties[0])) : sourceIndent
      editor.insertProperties(envOptions, envValue.properties.map(item => reindent(text(item), propertyIndent, indent)), removed)
      return true
    }
    let moved = false
    const targetEnv = optionObjects[0] ? property(optionObjects[0], "env") : undefined
    const targetEnvValue = targetEnv ? unwrapExpression(targetEnv.value) : undefined
    // `vitehub({ env: false })` next to the app's own `hubEnv()`: the declarations belong to that plugin.
    const envOff = targetEnvValue?.type === "BooleanLiteral" && !targetEnvValue.value
    if (viteHubTargets > 1) follow(envProperty, "The config has more than one vite-hub options object. Move env into the right one by hand.")
    else if (optionObjects[0] && envOff && hubEnvCalls.length !== 1) follow(envProperty, "vitehub({ env: false }) turns Env off, but the config declares Env. Remove one of them.")
    else if (optionObjects[0] && !envOff) moved = moveInto(optionObjects[0], true)
    else if (emptyCalls[0]) {
      const callIndent = indentAt(code, start(emptyCalls[0]))
      const indent = `${callIndent}${editor.style.indent}`
      editor.output.appendLeft(end(emptyCalls[0]) - 1, `{\n${indent}env: ${reindent(envText, sourceIndent, indent)},\n${callIndent}}`)
      moved = true
    }
    else if (hubEnvCalls.length === 1) {
      const call = hubEnvCalls[0]!
      const [argument] = call.arguments
      const options = objectValue(argument)
      if (options) moved = moveInto(options, false)
      else if (!argument) {
        editor.output.appendLeft(end(call) - 1, reindent(envText, sourceIndent, indentAt(code, start(call))))
        moved = true
      }
      else follow(envProperty, "hubEnv() options are not an object literal. Move these declarations into hubEnv() by hand.")
    }
    else {
      follow(envProperty, nuxt
        ? "vite.env is no longer read. Move these declarations into the vite-hub/nuxt options, under vitehub.env."
        : "The top-level Vite env key is no longer read. Move these declarations into vitehub({ env }), or into hubEnv() for a standalone Env plugin.")
    }
    if (moved) {
      const viteProperty = nuxt ? property(root, "vite") : undefined
      if (viteProperty && viteObject.properties.length === 1) remove(viteProperty)
      else remove(envProperty)
    }
  }

  if (viteObject) {
    for (const key of removedViteKeys) {
      const item = property(viteObject, key)
      if (!item || removed.has(item)) continue
      const value = unwrapExpression(item.value)
      const sourceIndent = indentAt(code, start(item))
      const plugin = ownerPlugins[key]
      const pluginCalls = plugin && !nuxt ? callsOf(root, importedNames(program, [`@vite-hub/${plugin.package}/vite`, `vite-hub/${plugin.package}/vite`], plugin.name)) : []
      // The key moves to the one place that reads it now: the vite-hub options, or the owner plugin's argument.
      if (key !== "vitehub" && optionObjects.length === 1 && !emptyCalls.length && !property(optionObjects[0]!, key)) {
        editor.insertProperties(optionObjects[0]!, [`${key}: ${reindent(text(value), sourceIndent, editor.propertyIndent(optionObjects[0]!))}`], removed)
        remove(item)
      }
      else if (!optionObjects.length && !emptyCalls.length && pluginCalls.length === 1 && !pluginCalls[0]!.arguments.length) {
        editor.output.appendLeft(end(pluginCalls[0]!) - 1, reindent(text(value), sourceIndent, indentAt(code, start(pluginCalls[0]!))))
        remove(item)
      }
      else {
        follow(item, nuxt
          ? `vite.${key} is no longer read. Set ${key} in the vite-hub/nuxt options.`
          : `The top-level Vite ${key} key is no longer read. Move it into vitehub({ ${key} }), or pass it to the feature's plugin.`)
      }
    }
  }
  }

  return changed ? { code: editor.output.toString(), changed, followUps, notes } : unchanged
}
