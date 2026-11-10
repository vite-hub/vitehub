import { readFileSync } from "node:fs"

import { objectProperties, scanModule, staticString, unwrapExpression, walk } from "@vite-hub/internal/build/scan-module"
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

// A default export that is an object literal must carry `adapter`, unless a spread or computed key can add it.
function canBeChannelDefinitionObject(value: Node): boolean {
  if (value.type !== "ObjectExpression") return true
  return objectProperties(value).some(property => property.node.type === "SpreadElement" || property.key === undefined || property.key === "adapter")
}

function exportName(node: { type: "Identifier", name: string } | { type: "Literal", value: string }): string {
  return node.type === "Identifier" ? node.name : node.value
}

/**
 * A module in `server/channels` is a Channel when its default export can be a `defineChannel()` result: not a
 * function, a class, a primitive, an array, or an object literal without `adapter`. The module is read, not run. A module
 * that cannot be read statically stays a Channel, so the runtime reports its problems.
 */
function isChannelModule(file: string): boolean {
  return isOutboundChannelSource(readFileSync(file, "utf8"), file)
}

/** Classifies a Channel's source without running it or requiring a file on disk. */
export function isOutboundChannelSource(source: string, file: string): boolean {
  const module = scanModule(source, file)
  if (module.errors.length) return true

  const bindings = new Map<string, Node>()
  let defaultExport: Node | undefined
  let hasDefault = false
  let reexportsAll = false

  for (const statement of module.program.body) {
    if (statement.type === "ImportDeclaration") continue
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
      // `export *` can re-export a default from a module that this check does not read.
      if (!statement.exported) reexportsAll = true
      else if (exportName(statement.exported) === "default") hasDefault = true
      continue
    }

    const exported = statement.type === "ExportNamedDeclaration"
    const declaration = exported ? statement.declaration : statement
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue
        if (item.init) bindings.set(item.id.name, unwrapExpression(item.init))
      }
    }
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id) bindings.set(declaration.id.name, declaration)
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === "type") continue
      const name = exportName(specifier.exported)
      if (name === "default") {
        hasDefault = true
        defaultExport = statement.source ? undefined : specifier.local
      }
    }
  }

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
  return value.type === "CallExpression" || (!nonDefinitionTypes.has(value.type) && canBeChannelDefinitionObject(value))
}

const channelModules = new Set(["vite-hub/channels", "@vite-hub/channels"])
const webhookAdapterNames = new Set(["stripe", "webhook"])

/**
 * Whether a Channel module receives webhooks: it imports `webhook()` or `stripe()`, also through a namespace. The
 * Agent package serves those webhooks, so the Vite plugin checks that it is on.
 */
export function receivesChannelWebhooks(file: string): boolean {
  const module = scanModule(readFileSync(file, "utf8"), file)
  if (module.errors.length) return false
  const namespaces = new Set<string>()
  for (const statement of module.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !channelModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name)
      if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && webhookAdapterNames.has(exportName(specifier.imported))) return true
    }
  }
  let receivesWebhooks = false
  walk(module.program, (node) => {
    if (node.type !== "MemberExpression" || node.object.type !== "Identifier" || !namespaces.has(node.object.name)) return
    const name = node.computed ? staticString(node.property) : node.property.type === "Identifier" ? node.property.name : undefined
    if (name && webhookAdapterNames.has(name)) receivesWebhooks = true
  })
  return receivesWebhooks
}

function discoverServerChannels(scanDirs: string[]): DiscoveredChannelDefinition[] {
  return discoverServerChannelModules(scanDirs)
    .map(definition => ({ handler: definition.handler, name: definition.name, source: "server-channels" as const }))
    .filter(definition => isChannelModule(definition.handler))
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
