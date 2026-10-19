import { readFileSync } from "node:fs"

import { scanModule, unwrapExpression } from "@vite-hub/internal/build/scan-module"
import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"
import { basename, dirname, relative, resolve } from "pathe"

import type { Node } from "@vite-hub/internal/build/scan-module"
import type { DiscoveredChannelDefinition } from "./types.ts"

const channelSuffixPattern = /\.channel\.(?:c|m)?[jt]s$/i
const channelIndexPattern = /^index\.(?:c|m)?[jt]sx?$/i

function normalizeSuffixChannelName(rootDir: string, file: string): string {
  return normalizeSuffixDefinitionName(rootDir, file, channelSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryChannelName(directory: string, file: string): string {
  return normalizePathDefinitionName(directory, file).replace(/\.channel$/i, "")
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
])

function exportName(node: { type: "Identifier", name: string } | { type: "Literal", value: string }): string {
  return node.type === "Identifier" ? node.name : node.value
}

/**
 * `server/channels` can also hold Agent Channels from `defineChannel()` and Channel factories. A module is an
 * outbound Channel when it exports `connectors`, or when its default export can be a Channel Definition object: not
 * a function, a class, a primitive, an array, or an Agent `defineChannel()` call. The module is read, not run. A
 * module that cannot be read statically stays a Channel, so the runtime reports its problems.
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
  if (value.type !== "CallExpression") return !nonDefinitionTypes.has(value.type)
  const callee = unwrapExpression(value.callee)
  if (callee.type === "Identifier") return !agentChannelFactories.has(callee.name)
  return !(callee.type === "MemberExpression"
    && callee.object.type === "Identifier"
    && agentChannelNamespaces.has(callee.object.name)
    && !callee.computed
    && callee.property.name === "defineChannel")
}

// A folder below `server/channels` with an `index` module is one Channel. Its other files are helpers.
function withChannelFolders(channelRoots: string[], definitions: DiscoveredChannelDefinition[]): DiscoveredChannelDefinition[] {
  const roots = new Set(channelRoots.map(root => resolve(root)))
  const folders = definitions
    .map(definition => resolve(definition.handler))
    .filter(handler => channelIndexPattern.test(basename(handler)) && !roots.has(dirname(handler)))
    .map(handler => dirname(handler))
  return definitions.filter((definition) => {
    const handler = resolve(definition.handler)
    return !folders.some((folder) => {
      if (handler === resolve(folder, basename(handler)) && channelIndexPattern.test(basename(handler))) return false
      const path = relative(folder, handler)
      return !!path && !path.startsWith("..")
    })
  })
}

function discoverServerChannels(scanDirs: string[]): DiscoveredChannelDefinition[] {
  const definitions = discoverDefinitions("channel", [
    createDirectoryDefinitionSource("server-channels", scanDirs, "channels", {
      createDefinition: createDiscoveredChannelDefinition("server-channels"),
      normalizeName: normalizeDirectoryChannelName,
    }),
  ])
  return withChannelFolders(scanDirs.map(directory => resolve(directory, "channels")), definitions)
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
