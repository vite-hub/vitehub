import { readFileSync } from "node:fs"

import { argumentExpression, objectProperties, scanModule, staticString, unwrapExpression } from "@vite-hub/internal/build/scan-module"
import { discoverServerChannelModules } from "@vite-hub/internal/definition-catalog"

import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { Expression, Node } from "@vite-hub/internal/build/scan-module"

/** A Channel module in `server/channels` that owns its webhook route without an Agent Definition. */
export interface StandaloneChannel {
  /** The Agent that hosts the Channel's webhook route, `channel-<name>`. It is not a public Agent Definition. */
  agent: string
  handler: string
  /** The Channel name, from its path below `server/channels`, as for outbound Channels. */
  name: string
  /** `webhooks.path` values, then `webhooks.aliases` values. */
  paths: string[]
}

const agentChannelModules = new Set(["vite-hub/agent/channels", "@vite-hub/agent/channels"])

function exportName(node: { type: "Identifier", name: string } | { type: "Literal", value: string }): string {
  return node.type === "Identifier" ? node.name : node.value
}

function standaloneChannelError(file: string, message: string): Error {
  return agentDiagnostics.AGENT_B0024({ message: `[vitehub] Channel ${file}: ${message}` })
}

/**
 * Reads the `webhooks.path` and `webhooks.aliases` values of `export default defineChannel(kind, options)` without
 * running the module. Returns undefined when the module does not default-export a `defineChannel()` call with a path.
 */
function readStandaloneChannelPaths(file: string): string[] | undefined {
  const module = scanModule(readFileSync(file, "utf8"), file)
  if (module.errors.length) throw standaloneChannelError(file, `cannot parse the module: ${module.errors[0]!.message}`)

  const bindings = new Map<string, Expression>()
  const factories = new Set<string>()
  const namespaces = new Set<string>()
  let defaultExport: Expression | undefined
  for (const statement of module.program.body) {
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type" || !agentChannelModules.has(statement.source.value)) continue
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && exportName(specifier.imported) === "defineChannel") factories.add(specifier.local.name)
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name)
      }
      continue
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration
      if (declaration.type !== "FunctionDeclaration" && declaration.type !== "ClassDeclaration" && declaration.type !== "TSInterfaceDeclaration") defaultExport = unwrapExpression(declaration)
      continue
    }
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier" && item.init) bindings.set(item.id.name, unwrapExpression(item.init))
      }
    }
    if (statement.type === "ExportNamedDeclaration" && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (exportName(specifier.exported) === "default" && specifier.local.type === "Identifier") defaultExport = specifier.local
      }
    }
  }

  // Follows local `const` bindings, so `const options = { ... }` reads like an inline object.
  function resolveValue(node: Expression | undefined): Expression | undefined {
    const seen = new Set<string>()
    while (node?.type === "Identifier" && bindings.has(node.name) && !seen.has(node.name)) {
      seen.add(node.name)
      node = bindings.get(node.name)
    }
    return node
  }

  // The last member named `name`, also through spreads of local objects. Undefined when it cannot be read.
  function property(node: Expression | undefined, name: string): Expression | undefined {
    const object = resolveValue(node)
    if (object?.type !== "ObjectExpression") return
    for (const member of objectProperties(object).reverse()) {
      if (member.node.type === "SpreadElement") {
        const value = property(unwrapExpression(member.node.argument), name)
        if (value) return value
      }
      else if (member.key === name) return resolveValue(member.value)
    }
  }

  function isDefineChannel(callee: Node): boolean {
    if (callee.type === "Identifier") return factories.has(callee.name)
    if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier" || !namespaces.has(callee.object.name)) return false
    return callee.computed
      ? callee.property.type === "Literal" && callee.property.value === "defineChannel"
      : callee.property.type === "Identifier" && callee.property.name === "defineChannel"
  }

  const definition = resolveValue(defaultExport)
  if (definition?.type !== "CallExpression" || !isDefineChannel(unwrapExpression(definition.callee))) return
  const webhooks = property(argumentExpression(definition.arguments[1]), "webhooks")
  const registrations = webhooks?.type === "ArrayExpression"
    ? webhooks.elements.flatMap(element => element && element.type !== "SpreadElement" ? [unwrapExpression(element)] : [])
    : [webhooks]
  const paths: string[] = []
  const aliases: string[] = []
  for (const registration of registrations) {
    const pathNode = property(registration, "path")
    if (!pathNode) continue
    const path = staticString(pathNode)
    if (path === undefined) throw standaloneChannelError(file, "webhooks.path must be a string literal. ViteHub reads it without running the module.")
    paths.push(path)
    const aliasesNode = property(registration, "aliases")
    if (!aliasesNode) continue
    const values = aliasesNode.type === "ArrayExpression"
      ? aliasesNode.elements.map(element => element && element.type !== "SpreadElement" ? staticString(resolveValue(unwrapExpression(element))) : undefined)
      : [undefined]
    if (values.some(value => value === undefined)) throw standaloneChannelError(file, "webhooks.aliases must be an array of string literals. ViteHub reads it without running the module.")
    aliases.push(...values.filter(value => value !== undefined))
  }
  return paths.length ? [...paths, ...aliases] : undefined
}

/**
 * Finds the Channel modules in `server/channels` that default-export `defineChannel()` with a `webhooks.path`. Each
 * one gets its webhook routes without an Agent Definition. Names follow the outbound Channel rule: a folder with an
 * `index` module is one Channel named after the folder, and its other files are helpers.
 */
export function discoverStandaloneChannels(serverDirs: string[]): StandaloneChannel[] {
  return discoverServerChannelModules(serverDirs).flatMap((module) => {
    const paths = readStandaloneChannelPaths(module.handler)
    return paths ? [{ agent: `channel-${module.name}`, handler: module.handler, name: module.name, paths }] : []
  })
}

/** Adds a webhook alias for each path of each standalone Channel. A path that already selects another target is an error. */
export function standaloneChannelWebhookAliases(
  channels: readonly StandaloneChannel[],
  aliases: Record<string, { agent: string, webhook: string }> = {},
): Record<string, { agent: string, webhook: string }> {
  const result = { ...aliases }
  const normalized = new Map(Object.entries(aliases).map(([path, target]) => [normalizeAliasPath(path), { path, target }]))
  for (const channel of channels) {
    for (const path of channel.paths) {
      const existing = normalized.get(normalizeAliasPath(path))
      // An explicitly configured alias selects its owner, even when a standalone
      // Channel happens to declare the same path.
      if (existing) {
        if (aliases[existing.path]) continue
        if (existing.target?.agent === channel.agent && existing.target?.webhook === channel.name) continue
        throw standaloneChannelError(channel.handler, `the webhook path ${JSON.stringify(path)} is already routed to ${JSON.stringify(`${existing.target?.agent}/${existing.target?.webhook}`)}.`)
      }
      const target = { agent: channel.agent, webhook: channel.name }
      normalized.set(normalizeAliasPath(path), { path, target })
      result[path] = target
    }
  }
  return result
}

function normalizeAliasPath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`.replace(/\/+$/, "") || "/"
}
