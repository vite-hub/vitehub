import { readFileSync } from "node:fs"

import { findProperty, objectProperties, scanModule, unwrapExpression } from "@vite-hub/internal/build/scan-module"
import {
  createSuffixDefinitionSource,
  discoverDefinitions,
  discoverServerChannelModules,
  mergeDefinitions,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"
import { resolve } from "pathe"

import type { Node } from "@vite-hub/internal/build/scan-module"
import type { DiscoveredChannelDefinition } from "./types.ts"

const channelSuffixPattern = /\.channel\.(?:c|m)?[jt]s$/i

function normalizeSuffixChannelName(rootDir: string, file: string): string {
  return normalizeSuffixDefinitionName(rootDir, file, channelSuffixPattern, { stripPrefix: "src/" })
}

function createDiscoveredChannelDefinition(source: DiscoveredChannelDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredChannelDefinition => ({
    handler: context.file,
    name: context.name,
    source,
  })
}

const agentChannelModules = new Set(["vite-hub/agent/channels", "@vite-hub/agent/channels"])
// Default exports that cannot be a Channel Definition object.
const nonDefinitionTypes = new Set<string>([
  "ArrayExpression",
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "Literal",
  "TemplateLiteral",
  "UnaryExpression",
])

function exportName(node: { type: "Identifier", name: string } | { type: "Literal", value: string }): string {
  return node.type === "Identifier" ? node.name : node.value
}

function canBeChannelDefinitionObject(value: Node): boolean {
  if (value.type !== "ObjectExpression") return true
  const properties = objectProperties(value)
  const connectors = findProperty(value, "connectors")
  if (!connectors) return properties.some(property => property.node.type === "SpreadElement" || property.key === undefined)
  const connectorsIndex = properties.indexOf(connectors)
  if (properties.slice(connectorsIndex + 1).some(property => property.node.type === "SpreadElement" || property.key === undefined)) return true
  return connectors.value === undefined || canBeConnectorMap(connectors.value)
}

const functionTypes = new Set(["ArrowFunctionExpression", "FunctionExpression"])

function canBeConnector(value: Node): boolean {
  if (value.type !== "ObjectExpression") return !nonDefinitionTypes.has(value.type)
  const properties = objectProperties(value)
  let knownSend = false
  for (const property of properties.toReversed()) {
    if (property.node.type === "SpreadElement" || property.key === undefined) return true
    if (property.key !== "send" || knownSend) continue
    knownSend = true
    return property.value === undefined || functionTypes.has(property.value.type) || !nonDefinitionTypes.has(property.value.type)
  }
  return false
}

function canBeConnectorMap(value: Node): boolean {
  if (value.type !== "ObjectExpression") return value.type !== "ArrayExpression" && !nonDefinitionTypes.has(value.type)
  const properties = objectProperties(value)
  if (!properties.length) return false
  const seen = new Set<string>()
  let knownConnector = false
  for (const property of properties.toReversed()) {
    if (property.node.type === "SpreadElement" || property.key === undefined) return true
    if (seen.has(property.key)) continue
    seen.add(property.key)
    knownConnector = true
    if (property.value === undefined || !canBeConnector(property.value)) return false
  }
  return knownConnector
}

/**
 * `server/channels` can also hold Agent Channels from `defineChannel()` and Channel factories. A module is an
 * outbound Channel when it exports `connectors`, or when its default export can be a Channel Definition object with
 * `connectors`: not a function, a class, a primitive, an array, or an Agent `defineChannel()` call. The module is read,
 * not run. A module that cannot be read statically stays a Channel, so the runtime reports its problems.
 */
function isOutboundChannelModule(file: string): boolean {
  const module = scanModule(readFileSync(file, "utf8"), file)
  if (module.errors.length) return true

  const bindings = new Map<string, Node>()
  const agentChannelFactories = new Set<string>()
  const agentChannelNamespaces = new Set<string>()
  let defaultExport: Node | undefined
  let hasDefault = false
  let exportsConnectors = false
  let reexportsAll = false

  for (const statement of module.program.body) {
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type" || !agentChannelModules.has(statement.source.value)) continue
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && exportName(specifier.imported) === "defineChannel") agentChannelFactories.add(specifier.local.name)
        if (specifier.type === "ImportNamespaceSpecifier") agentChannelNamespaces.add(specifier.local.name)
      }
      continue
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration
      // An interface is a type. The module has no default export at runtime.
      if (declaration.type === "TSInterfaceDeclaration") continue
      hasDefault = true
      defaultExport = declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration" ? declaration : unwrapExpression(declaration)
      continue
    }
    if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") continue
      // `export *` can re-export `connectors` from a module that this check does not read.
      if (!statement.exported) reexportsAll = true
      else if (exportName(statement.exported) === "connectors") exportsConnectors = true
      else if (exportName(statement.exported) === "default") hasDefault = true
      continue
    }

    const exported = statement.type === "ExportNamedDeclaration"
    const declaration = exported ? statement.declaration : statement
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue
        if (item.init) bindings.set(item.id.name, unwrapExpression(item.init))
        if (exported && item.id.name === "connectors") exportsConnectors = true
      }
    }
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id) bindings.set(declaration.id.name, declaration)
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === "type") continue
      const name = exportName(specifier.exported)
      if (name === "connectors") exportsConnectors = true
      if (name === "default") {
        hasDefault = true
        defaultExport = statement.source ? undefined : specifier.local
      }
    }
  }

  // Follow local aliases assigned from an imported Agent `defineChannel`.
  // This keeps static classification aligned with the runtime call even when
  // the default export goes through one or more intermediate bindings.
  let aliasesChanged = true
  while (aliasesChanged) {
    aliasesChanged = false
    for (const [name, binding] of bindings) {
      if (binding.type === "Identifier" && agentChannelFactories.has(binding.name) && !agentChannelFactories.has(name)) {
        agentChannelFactories.add(name)
        aliasesChanged = true
      }
    }
  }

  if (exportsConnectors) return true
  if (!hasDefault) return reexportsAll

  const seen = new Set<string>()
  let value = defaultExport
  while (value?.type === "Identifier" && !seen.has(value.name)) {
    seen.add(value.name)
    const binding = bindings.get(value.name)
    if (!binding) break
    value = binding
  }
  if (!value) return true
  if (value.type === "Identifier" && (value.name === "undefined" || value.name === "NaN" || value.name === "Infinity")) return false
  if (value.type !== "CallExpression") return !nonDefinitionTypes.has(value.type) && canBeChannelDefinitionObject(value)
  const callee = unwrapExpression(value.callee)
  if (callee.type === "Identifier") return !agentChannelFactories.has(callee.name)
  return !(callee.type === "MemberExpression"
    && callee.object.type === "Identifier"
    && agentChannelNamespaces.has(callee.object.name)
    && (!callee.computed
      ? callee.property.type === "Identifier" && callee.property.name === "defineChannel"
      : callee.property.type === "Literal" && callee.property.value === "defineChannel"))
}

function discoverServerChannels(scanDirs: string[]): DiscoveredChannelDefinition[] {
  return discoverServerChannelModules(scanDirs)
    .map(definition => ({ handler: definition.handler, name: definition.name, source: "server-channels" as const }))
    .filter(definition => isOutboundChannelModule(definition.handler))
}

export function discoverChannelDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverDirs?: string[], serverRootDirs?: string[] }
  | { mode: "server-channels", scanDirs: string[] }
): DiscoveredChannelDefinition[] {
  if (options.mode === "server-channels") {
    return discoverServerChannels(options.scanDirs)
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs ?? [...new Set(options.serverRootDirs || roots)].map(root => resolve(root, "server"))
  const channelDirectories = serverScanDirs.map(directory => `${resolve(directory, "channels").replace(/\\/g, "/")}/`)
  const suffixDefinitions = discoverDefinitions("channel", [
    createSuffixDefinitionSource("vite-suffix", roots, channelSuffixPattern, normalizeSuffixChannelName, {
      createDefinition: createDiscoveredChannelDefinition("vite-suffix"),
    }),
  ]).filter((definition) => {
    const handler = resolve(definition.handler).replace(/\\/g, "/")
    return !channelDirectories.some(directory => handler.startsWith(directory))
  })

  return mergeDefinitions(
    "channel",
    suffixDefinitions,
    discoverServerChannels(serverScanDirs),
  )
}
