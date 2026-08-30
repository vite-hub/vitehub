import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, relative, resolve } from "node:path"

import { createDefaultCloudflareOutputRoot, writeCloudflareWranglerConfig } from "@vite-hub/internal/build/cloudflare"
import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"

import { createWorkspaceDefinitionLoader, loadDiscoveredWorkspaceDefinition } from "../../build/assets.ts"
import { createWorkspaceRegistryContents, discoverViteWorkspaceDefinitions } from "../../build/discovery.ts"
import { initializeWorkspaceAssetRegistry, refreshWorkspaceBuildState, syncWorkspaceBuildAssets } from "../../build/integration.ts"
import { workspaceSuffixPattern } from "../../build/workspace-config.ts"
import { createWorkspaceCliContributor } from "../../cli.ts"
import { normalizeWorkspaceOptions } from "../../config.ts"
import { normalizeWorkspaceDefinition } from "../../core/registry.ts"
import { installHostedWorkspaceRuntime } from "../../hosted.ts"
import { installHostedVercelBlobWorkspaceRuntime } from "../../hosted-vercel-blob.ts"
import { configureCloudflareArtifacts } from "../../integrations/cloudflare.ts"
import { ensureWorkspaceDevToken, refreshWorkspaceDevToken, runWorkspaceDevCommand, validateWorkspaceDevToken, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevRoute, workspaceDevTokenServerId } from "../../server.ts"

import type { AliasOptions, HmrContext, Plugin, ResolvedConfig, UserConfig, ViteDevServer } from "vite"
import type { DiscoveredWorkspaceDefinition } from "../../build/discovery.ts"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { WorkspaceBuildState } from "../../build/integration.ts"
import type { ResolvedWorkspaceModuleOptions, WorkspaceDefinitionInput, WorkspaceModuleOptions } from "../../core/types.ts"
import type { WorkspaceDevTokenOptions } from "../../server.ts"

const WORKSPACE_PACKAGE_NAME = "@vite-hub/workspace"
const WORKSPACES_ID = "#vitehub/workspaces"
const WORKSPACE_PREFIX = "#vitehub/workspaces/"
const WORKSPACE_ASSETS_REGISTRY_ID = "#vitehub-workspace-assets-registry"
const WORKSPACE_REGISTRY_ID = "#vitehub-workspace-registry"
const RESOLVED_WORKSPACES_ID = `\0${WORKSPACES_ID}`
const RESOLVED_WORKSPACE_PREFIX = `\0${WORKSPACE_PREFIX}`
const RESOLVED_WORKSPACE_REGISTRY_ID = `\0${WORKSPACE_REGISTRY_ID}`
const generatedNitroWorkspacePlugin = ".vitehub/nitro/workspace/plugin.ts"
const generatedNitroWorkspaceRegistry = ".vitehub/nitro/workspace/registry.js"
const cloudflareArtifactsBindingsFileName = ".vitehub-workspace-artifacts-bindings.json"
const mergeNoExternal = createNoExternalMerger(WORKSPACE_PACKAGE_NAME)
const workspacesDirSegment = /[\\/](?:server[\\/])?workspaces(?:[\\/]|$)/

const sourceModuleExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]

async function readSourceModule(file: string): Promise<{ file: string, source: string } | undefined> {
  const candidates = extname(file)
    ? [file]
    : [
        ...sourceModuleExtensions.map(extension => `${file}${extension}`),
        ...sourceModuleExtensions.map(extension => resolve(file, `index${extension}`)),
      ]
  for (const candidate of candidates) {
    try {
      return { file: candidate, source: await readFile(candidate, "utf8") }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

interface BabelNode {
  arguments?: BabelNode[]
  callee?: BabelNode
  computed?: boolean
  elements?: Array<BabelNode | null>
  expression?: BabelNode
  init?: BabelNode
  imported?: BabelNode
  id?: BabelNode
  key?: { name?: unknown, type?: string, value?: unknown }
  name?: string
  object?: BabelNode
  property?: BabelNode
  properties?: BabelNode[]
  right?: BabelNode
  source?: BabelNode
  specifiers?: BabelNode[]
  local?: BabelNode
  exported?: BabelNode
  left?: BabelNode
  type?: string
  value?: BabelNode | unknown
}

interface BabelObjectPropertyPath {
  node: BabelNode
  parentPath?: BabelObjectPropertyPath
  scope: BabelScope
}

type BabelNodePath = BabelObjectPropertyPath

interface BabelBindingPath {
  node: BabelNode
  parentPath?: BabelNodePath
  scope: BabelScope
}

interface BabelScope {
  getBinding: (name: string) => { path: BabelBindingPath, referencePaths?: BabelNodePath[] } | undefined
}

type SourceModuleResolver = (id: string, importer: string) => Promise<string | undefined>

function createSourceModuleResolver(
  rootDir: string,
  aliases?: Record<string, string>,
  resolveModule?: SourceModuleResolver,
): SourceModuleResolver | undefined {
  if (!aliases) return resolveModule
  return async (id, importer) => {
    const resolved = await resolveModule?.(id, importer)
    if (resolved) return resolved
    for (const [find, replacement] of Object.entries(aliases)) {
      if (id !== find && !id.startsWith(`${find}/`)) continue
      const aliased = `${replacement}${id.slice(find.length)}`
      return isAbsolute(aliased) ? aliased : resolve(rootDir, aliased)
    }
  }
}

function babelPropertyName(path: BabelObjectPropertyPath): unknown {
  return path.node.key?.name ?? path.node.key?.value
}

function babelPathOrBindingIsExported(path: BabelNodePath, name?: string): boolean {
  if (babelPathIsExported(path)) return true
  if (!name) return false
  const binding = path.scope.getBinding(name)
  return binding?.referencePaths?.some(babelPathIsExported) ?? false
}

function babelBindingIsExportedAs(path: BabelNodePath, localName: string, exportedName: string): boolean {
  return path.scope.getBinding(localName)?.referencePaths?.some((reference) => {
    const parent = reference.parentPath?.node
    if (parent?.type !== "ExportSpecifier" || parent.local !== reference.node) return false
    return (parent.exported?.name ?? parent.exported?.value) === exportedName
  }) ?? false
}

function babelPathReachesDefaultExport(path: BabelNodePath, seen = new Set<BabelNodePath>()): boolean {
  if (seen.has(path)) return false
  seen.add(path)
  for (let current: BabelNodePath | undefined = path; current; current = current.parentPath) {
    if (current.node.type === "ExportDefaultDeclaration") return true
    if (
      current.node.type === "AssignmentExpression"
      && babelMemberIsCommonJsDefaultExport(current.node.left)
    ) return true
    if (current.node.type === "VariableDeclarator" && current.node.id?.type === "Identifier" && current.node.id.name) {
      const binding = current.scope.getBinding(current.node.id.name)
      if (binding?.referencePaths?.some(reference => babelPathReachesDefaultExport(reference, seen))) return true
    }
  }
  return false
}

function babelMemberIsCommonJsDefaultExport(member: BabelNode | undefined): boolean {
  if (member?.type !== "MemberExpression") return false
  if (
    member.object?.type === "Identifier"
    && member.object.name === "module"
    && member.property?.type === "Identifier"
    && member.property.name === "exports"
  ) return true
  if ((member.property?.name ?? member.property?.value) !== "default") return false
  return (
    member.object?.type === "Identifier"
    && member.object.name === "exports"
  ) || (
    member.object?.type === "MemberExpression"
    && member.object.object?.type === "Identifier"
    && member.object.object.name === "module"
    && member.object.property?.type === "Identifier"
    && member.object.property.name === "exports"
  )
}

function babelPathIsDirectDefaultExport(path: BabelNodePath): boolean {
  const parent = path.parentPath?.node
  if (parent?.type === "ExportDefaultDeclaration") return true
  return parent?.type === "AssignmentExpression"
    && parent.right === path.node
    && babelMemberIsCommonJsDefaultExport(parent.left)
}

function babelPropertyIsTopLevelDefaultExport(path: BabelNodePath): boolean {
  for (let current = path.parentPath; current; current = current.parentPath) {
    if (current.node.type === "ObjectProperty") return false
    if (current.node.type === "ExportDefaultDeclaration") return true
    if (
      current.node.type === "AssignmentExpression"
      && babelMemberIsCommonJsDefaultExport(current.node.left)
    ) return true
    if (current.node.type === "VariableDeclarator" && current.node.id?.type === "Identifier" && current.node.id.name) {
      const binding = current.scope.getBinding(current.node.id.name)
      return binding?.referencePaths?.some(reference => babelPathReachesDefaultExport(reference)) ?? false
    }
  }
  return false
}

function babelPathReachesExportedStore(path: BabelNodePath, seen = new Set<BabelNodePath>()): boolean {
  if (seen.has(path)) return false
  seen.add(path)
  for (let current: BabelNodePath | undefined = path; current; current = current.parentPath) {
    if (
      current.node.type === "ObjectProperty"
      && !["binding", "namespace", "provider", "store"].includes(String(babelPropertyName(current)))
    ) return false
    if (
      current.node.type === "ObjectProperty"
      && babelPropertyName(current) === "store"
      && babelPropertyIsTopLevelDefaultExport(current)
    ) return true
    if (current.node.type === "VariableDeclarator" && current.node.id?.type === "Identifier" && current.node.id.name) {
      const binding = current.scope.getBinding(current.node.id.name)
      if (binding?.referencePaths?.some(reference => babelPathReachesExportedStore(reference, seen))) return true
    }
    if (current.node.type === "FunctionDeclaration" && current.node.id?.name) {
      let returned = false
      for (let descendant: BabelNodePath | undefined = path; descendant && descendant !== current; descendant = descendant.parentPath) {
        if (descendant.node.type === "ReturnStatement") returned = true
        if (descendant !== path && (descendant.node.type === "FunctionDeclaration" || descendant.node.type === "FunctionExpression" || descendant.node.type === "ArrowFunctionExpression")) break
      }
      if (!returned) return false
      const binding = current.scope.getBinding(current.node.id.name)
      if (binding?.referencePaths?.some(reference => babelPathReachesExportedStore(reference, seen))) return true
    }
  }
  return false
}

function babelNamespaceMemberNames(
  path: BabelNodePath,
  reachesRequestedExport: (path: BabelNodePath) => boolean,
  seen = new Set<BabelNodePath>(),
): string[] {
  if (seen.has(path)) return []
  seen.add(path)
  const parent = path.parentPath
  if (parent?.node.type === "MemberExpression" && parent.node.object === path.node) {
    if (!reachesRequestedExport(parent)) return []
    const name = parent.node.property?.name ?? parent.node.property?.value
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babel member names cross the parser boundary as identifiers or literals.
    return typeof name === "string" ? [name] : []
  }
  if (
    parent?.node.type === "VariableDeclarator"
    && parent.node.init === path.node
    && parent.node.id?.type === "ObjectPattern"
  ) {
    // SAFETY: Babel's ObjectPattern discriminator above guarantees its properties collection.
    const properties = (parent.node.id as BabelNode & { properties?: BabelNode[] }).properties
    return properties?.flatMap((property) => {
      // SAFETY: Babel's ObjectProperty discriminator below guards the key and value fields consumed here.
      const objectProperty = property as BabelNode & {
        key?: { name?: unknown, value?: unknown }
        value?: { name?: string, type?: string }
      }
      if (objectProperty.type !== "ObjectProperty" || objectProperty.value?.type !== "Identifier" || !objectProperty.value.name) return []
      const references = parent.scope.getBinding(objectProperty.value.name)?.referencePaths ?? []
      if (!references.some(reachesRequestedExport)) return []
      const name = objectProperty.key?.name ?? objectProperty.key?.value
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babel destructuring keys cross the parser boundary as identifiers or literals.
      return typeof name === "string" ? [name] : []
    }) ?? []
  }
  if (
    parent?.node.type === "VariableDeclarator"
    && parent.node.init === path.node
    && parent.node.id?.type === "Identifier"
    && parent.node.id.name
  ) {
    return parent.scope.getBinding(parent.node.id.name)?.referencePaths
      ?.filter(reachesRequestedExport)
      .flatMap(reference => babelNamespaceMemberNames(reference, reachesRequestedExport, seen)) ?? []
  }
  return []
}

function babelPathBelongsToExportedStore(path: BabelNodePath): boolean {
  for (let current = path.parentPath; current; current = current.parentPath) {
    if (
      current.node.type === "AssignmentExpression"
      && current.node.left?.type === "MemberExpression"
      && current.node.left.object?.type === "Identifier"
      && current.node.left.object.name === "module"
      && current.node.left.property?.type === "Identifier"
      && current.node.left.property.name === "exports"
    ) return path.parentPath?.parentPath === current
    if (
      current.node.type === "ObjectProperty"
      && babelPropertyName(current) === "store"
      && babelPropertyIsTopLevelDefaultExport(current)
    ) return true
    if (
      current.node.type === "VariableDeclarator"
      && current.node.id?.type === "Identifier"
      && (
        (current.node.id.name === "store" && babelPathOrBindingIsExported(current, current.node.id.name))
        || current.scope.getBinding(current.node.id.name ?? "")?.referencePaths?.some(reference => babelPathReachesExportedStore(reference))
      )
    ) return true
    if (current.node.type === "ExportDefaultDeclaration") return path.parentPath?.parentPath === current
    if (current.node.type === "FunctionDeclaration") {
      const name = current.node.id?.name
      if (current.parentPath?.node.type === "ExportDefaultDeclaration") return true
      return name ? current.scope.getBinding(name)?.referencePaths?.some(reference => babelPathReachesExportedStore(reference)) ?? false : false
    }
    if (current.node.type === "FunctionExpression" || current.node.type === "ArrowFunctionExpression") {
      const declarator = current.parentPath
      if (declarator?.node.type === "ExportDefaultDeclaration") return true
      if (declarator?.node.type !== "VariableDeclarator" || declarator.node.init !== current.node || declarator.node.id?.type !== "Identifier") return false
      const name = declarator.node.id.name
      if (!name) return false
      return babelPathOrBindingIsExported(declarator, name)
        || declarator.scope.getBinding(name)?.referencePaths?.some(reference => babelPathReachesExportedStore(reference))
        || false
    }
  }
  return false
}

function babelPathIsExported(path: BabelNodePath): boolean {
  for (let current = path.parentPath; current; current = current.parentPath) {
    if (current.node.type === "ExportNamedDeclaration" || current.node.type === "ExportDefaultDeclaration") return true
  }
  return false
}

function babelPathReachesNamedExport(
  path: BabelNodePath,
  exportedName: string,
  seen = new Set<BabelNodePath>(),
  mayCrossValueProperty = true,
): boolean {
  if (seen.has(path)) return false
  seen.add(path)
  for (let current: BabelNodePath | undefined = path; current; current = current.parentPath) {
    if (
      current.node.type === "ObjectProperty"
      && babelPropertyName(current) === exportedName
      && current.parentPath
      && babelPathIsDirectDefaultExport(current.parentPath)
    ) return true
    if (current.node.type === "ObjectProperty") {
      if (!mayCrossValueProperty) return false
      mayCrossValueProperty = false
    }
    if (
      current.node.type === "AssignmentExpression"
      && current.node.left?.type === "MemberExpression"
      && (
        (current.node.left.object?.type === "Identifier" && current.node.left.object.name === "exports")
        || (
          current.node.left.object?.type === "MemberExpression"
          && current.node.left.object.object?.type === "Identifier"
          && current.node.left.object.object.name === "module"
          && current.node.left.object.property?.type === "Identifier"
          && current.node.left.object.property.name === "exports"
        )
      )
      && (current.node.left.property?.name ?? current.node.left.property?.value) === exportedName
    ) return true
    if (current.node.type === "VariableDeclarator" && current.node.id?.type === "Identifier" && current.node.id.name) {
      const name = current.node.id.name
      if (
        (name === exportedName && babelPathOrBindingIsExported(current, exportedName))
        || babelBindingIsExportedAs(current, name, exportedName)
      ) return true
      const binding = current.scope.getBinding(name)
      if (binding?.referencePaths?.some(reference => babelPathReachesNamedExport(reference, exportedName, seen, false))) return true
    }
    if (
      current.node.type === "FunctionDeclaration"
      && current.node.id?.name === exportedName
      && babelPathOrBindingIsExported(current, exportedName)
    ) return true
  }
  return false
}

function babelStringValue(node: BabelNode | undefined, path: BabelBindingPath, seen = new Set<BabelBindingPath>()): unknown {
  if (node?.type === "StringLiteral") return node.value
  if (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression" || node?.type === "TSTypeAssertion") {
    return babelStringValue(node.expression, path, seen)
  }
  if (node?.type === "Identifier" && node.name) {
    const bindingPath = path.scope.getBinding(node.name)?.path
    if (!bindingPath || seen.has(bindingPath)) return
    return babelStringValue(bindingPath.node.init, bindingPath, new Set(seen).add(bindingPath))
  }
  if (
    node?.type === "CallExpression"
    && node.arguments?.length === 1
    && babelStringValue(node.arguments[0], path, seen) === "-"
    && node.callee?.type === "MemberExpression"
    && node.callee.object?.type === "ArrayExpression"
    && node.callee.property?.type === "Identifier"
    && node.callee.property.name === "join"
  ) {
    const values = node.callee.object.elements?.map(element => babelStringValue(element ?? undefined, path, seen))
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babel literal evaluation must validate every computed array element before joining it.
    if (values?.every(value => typeof value === "string")) return values.join("-")
  }
}

async function sourceModuleDeclaresCloudflareArtifacts(
  file: string,
  loader: ReturnType<typeof createWorkspaceDefinitionLoader>,
  exportedName = "default",
): Promise<boolean> {
  const loaded = await readSourceModule(file)
  if (!loaded) return false
  let declaresCloudflareArtifacts = false
  loader.transform({
    filename: loaded.file,
    jsx: extname(loaded.file).endsWith("x"),
    source: loaded.source,
    ts: /\.[cm]?tsx?$/.test(loaded.file),
    babel: {
      plugins: [() => ({
        visitor: {
          ObjectProperty(path: BabelObjectPropertyPath) {
            const value = path.node.value as BabelNode | undefined
            const belongsToRequestedExport = exportedName === "default"
              ? babelPathBelongsToExportedStore(path)
              : babelPathReachesNamedExport(path, exportedName)
            if (
              babelPropertyName(path) === "provider"
              && belongsToRequestedExport
            ) {
              const provider = babelStringValue(value, path)
              if (provider === "cloudflare-artifacts" || provider === undefined) declaresCloudflareArtifacts = true
            }
          },
          VariableDeclarator(path: BabelNodePath) {
            if (
              exportedName === "provider"
              && path.node.id?.type === "Identifier"
              && path.node.id.name === "provider"
              && babelPathIsExported(path)
              && babelStringValue(path.node.init, path) === "cloudflare-artifacts"
            ) {
              declaresCloudflareArtifacts = true
            }
          },
          ExportNamedDeclaration(path: BabelNodePath) {
            if (exportedName !== "provider") return
            for (const specifier of path.node.specifiers ?? []) {
              if (specifier.exported?.name !== "provider" || specifier.local?.type !== "Identifier" || !specifier.local.name) continue
              if (babelStringValue(specifier.local, path) === "cloudflare-artifacts") declaresCloudflareArtifacts = true
            }
          },
        },
      })],
    },
  })
  return declaresCloudflareArtifacts
}

async function sourceModuleMayUseCloudflareArtifacts(
  file: string,
  loader: ReturnType<typeof createWorkspaceDefinitionLoader>,
  resolveModule?: SourceModuleResolver,
  visited = new Set<string>(),
  exportedName = "default",
): Promise<boolean> {
  const loaded = await readSourceModule(file)
  if (!loaded) return false
  const visitKey = `${loaded.file}\0${exportedName}`
  if (visited.has(visitKey)) return false
  visited.add(visitKey)
  if (await sourceModuleDeclaresCloudflareArtifacts(loaded.file, loader, exportedName)) return true

  for (const { importedName, selectedName, specifier } of sourceImportsFeedingWorkspaceStore(loaded, loader, exportedName)) {
    if (!importedName) return true
    const resolvedModule = specifier.startsWith(".")
      ? resolve(dirname(loaded.file), specifier)
      : await resolveModule?.(specifier, loaded.file)
    const resolvedFile = resolvedModule?.split(/[?#]/, 1)[0]
    if (resolvedFile && extname(resolvedFile) && !sourceModuleExtensions.includes(extname(resolvedFile))) continue
    const requestedName = selectedName ?? importedName
    if (resolvedFile && isAbsolute(resolvedFile) && await sourceModuleMayUseCloudflareArtifacts(resolvedFile, loader, resolveModule, visited, requestedName)) return true
  }
  return false
}

function sourceImportsFeedingWorkspaceStore(
  loaded: { file: string, source: string },
  loader: ReturnType<typeof createWorkspaceDefinitionLoader>,
  exportedName: string,
): Array<{ importedName?: string, localName?: string, selectedName?: string, specifier: string }> {
  const imports: Array<{ importedName?: string, localName?: string, selectedName?: string, specifier: string }> = []
  loader.transform({
    filename: loaded.file,
    jsx: extname(loaded.file).endsWith("x"),
    source: loaded.source,
    ts: /\.[cm]?tsx?$/.test(loaded.file),
    babel: {
      plugins: [() => ({
        visitor: {
          ExportNamedDeclaration(path: BabelNodePath) {
            const specifier = path.node.source?.value
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babel export sources may be absent or non-string parser nodes.
            if (typeof specifier !== "string") return
            for (const exported of path.node.specifiers ?? []) {
              const exportedAs = String(exported.exported?.name ?? exported.exported?.value)
              if (exportedAs !== exportedName) continue
              imports.push({
                importedName: String(exported.local?.name ?? exported.local?.value),
                specifier,
              })
            }
          },
          ExportAllDeclaration(path: BabelNodePath) {
            const specifier = path.node.source?.value
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babel export-all sources may be absent or non-string parser nodes.
            if (typeof specifier === "string" && exportedName !== "default") imports.push({ importedName: exportedName, specifier })
          },
          ImportDeclaration(path: BabelNodePath) {
            const specifier = path.node.source?.value
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babel import sources may be absent or non-string parser nodes.
            if (typeof specifier !== "string") return
            for (const imported of path.node.specifiers ?? []) {
              if (imported.local?.type !== "Identifier" || !imported.local.name) continue
              const binding = path.scope.getBinding(imported.local.name)
              const referenceReachesRequestedExport = (reference: BabelNodePath) => exportedName === "default"
                ? babelPathReachesExportedStore(reference) || babelPathIsDirectDefaultExport(reference)
                : (() => {
                    for (let current: BabelNodePath | undefined = reference; current; current = current.parentPath) {
                      if (
                        current.node.type === "ExportSpecifier"
                        && current.node.local === reference.node
                        && (current.node.exported?.name ?? current.node.exported?.value) === exportedName
                      ) return true
                      if (current.node.type === "VariableDeclarator" && current.node.id?.name === exportedName && babelPathOrBindingIsExported(current, exportedName)) return true
                    }
                    return false
                  })()
              if (imported.type === "ImportNamespaceSpecifier" || imported.type === "ImportDefaultSpecifier") {
                for (const reference of binding?.referencePaths ?? []) {
                  const memberNames = babelNamespaceMemberNames(reference, referenceReachesRequestedExport)
                  for (const importedName of memberNames) {
                    imports.push(imported.type === "ImportDefaultSpecifier"
                      ? { importedName: "default", selectedName: importedName, specifier }
                      : { importedName, specifier })
                  }
                  if (imported.type === "ImportDefaultSpecifier" && !memberNames.length && referenceReachesRequestedExport(reference)) {
                    imports.push({ importedName: "default", localName: imported.local.name, specifier })
                  }
                }
                continue
              }
              const references = binding?.referencePaths?.filter(referenceReachesRequestedExport) ?? []
              if (!references.length) continue
              imports.push({
                importedName: imported.type === "ImportDefaultSpecifier" ? "default" : String(imported.imported?.name ?? imported.imported?.value),
                localName: imported.local.name,
                specifier,
              })
            }
          },
          VariableDeclarator(path: BabelNodePath) {
            // SAFETY: Babel's AwaitExpression discriminator guarantees the argument field.
            const awaitExpression = path.node.init as BabelNode & { argument?: BabelNode }
            const awaited = path.node.init?.type === "AwaitExpression"
              ? awaitExpression.argument
              : path.node.init
            if (
              awaited?.type === "CallExpression"
              && awaited.callee?.type === "Import"
              && awaited.arguments?.length === 1
            ) {
              const specifier = awaited.arguments[0]?.value
              // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Dynamic import arguments must be statically resolvable strings.
              if (typeof specifier !== "string") return
              if (path.node.id?.type === "ObjectPattern") {
                // SAFETY: Babel's ObjectPattern discriminator above guarantees its properties collection.
                const properties = (path.node.id as BabelNode & { properties?: BabelNode[] }).properties
                for (const property of properties ?? []) {
                  if (property.type !== "ObjectProperty") continue
                  // SAFETY: The ObjectProperty discriminator guarantees a Babel-compatible value node.
                  const localName = (property.value as BabelNode | undefined)?.name
                  if (!localName) continue
                  const reaches = path.scope.getBinding(localName)?.referencePaths?.some(reference => exportedName === "default"
                    ? babelPathReachesExportedStore(reference)
                    : babelPathOrBindingIsExported(reference, exportedName))
                  if (!reaches) continue
                  const importedName = property.key?.name ?? property.key?.value
                  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Dynamic import destructuring keys cross the parser boundary.
                  imports.push({ importedName: typeof importedName === "string" ? importedName : undefined, localName, specifier })
                }
              }
              else if (path.node.id?.type === "Identifier") {
                const binding = path.scope.getBinding(path.node.id.name)
                for (const reference of binding?.referencePaths ?? []) {
                  const memberNames = babelNamespaceMemberNames(reference, candidate => exportedName === "default"
                    ? babelPathReachesExportedStore(candidate)
                    : babelPathOrBindingIsExported(candidate, exportedName))
                  for (const importedName of memberNames) imports.push({ importedName, specifier })
                }
              }
              return
            }
            const required = path.node.init?.type === "MemberExpression" ? path.node.init.object : path.node.init
            if (
              path.node.id?.type === "ObjectPattern"
              && required?.type === "CallExpression"
              && required.callee?.type === "Identifier"
              && required.callee.name === "require"
              && required.arguments?.length === 1
            ) {
              const specifier = required.arguments[0]?.value
              // doctor-disable-next-line typescript/strict/no-runtime-typeof -- CommonJS require arguments cross the parser boundary and must be string literals.
              if (typeof specifier !== "string") return
              // SAFETY: Babel's ObjectPattern discriminator above guarantees its properties collection.
              const properties = (path.node.id as BabelNode & { properties?: BabelNode[] }).properties
              for (const property of properties ?? []) {
                const value = property.value as BabelNode | undefined
                const local = value?.type === "AssignmentPattern" ? value.left : value
                const localName = local?.name
                if (property.type !== "ObjectProperty" || !localName) continue
                const reachesRequestedExport = path.scope.getBinding(localName)?.referencePaths?.some(reference => exportedName === "default"
                  ? babelPathReachesExportedStore(reference)
                  : babelPathOrBindingIsExported(reference, exportedName))
                if (!reachesRequestedExport) continue
                // SAFETY: Babel's ObjectProperty discriminator above guarantees a Babel-compatible key node.
                const key = property.key as BabelNode | undefined
                const importedName = property.computed
                  ? babelStringValue(key, path)
                  : property.key?.name ?? property.key?.value
                // doctor-disable-next-line typescript/strict/no-runtime-typeof -- CommonJS destructuring keys cross the parser boundary as identifiers or literals.
                imports.push({ importedName: typeof importedName === "string" ? importedName : undefined, specifier })
              }
              return
            }
            if (
              path.node.id?.type !== "Identifier"
              || !path.node.id.name
            ) return
            if (
              required?.type !== "CallExpression"
              || required.callee?.type !== "Identifier"
              || required.callee.name !== "require"
              || required.arguments?.length !== 1
            ) return
            const specifier = required.arguments[0]?.value
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- CommonJS require arguments cross the parser boundary and must be string literals.
            if (typeof specifier !== "string") return
            const binding = path.scope.getBinding(path.node.id.name)
            const reachesRequestedExport = (reference: BabelNodePath) => exportedName === "default"
              ? babelPathReachesExportedStore(reference) || babelPathIsDirectDefaultExport(reference)
              : babelPathOrBindingIsExported(reference, exportedName)
            const selectedNames = binding?.referencePaths?.flatMap(reference => babelNamespaceMemberNames(reference, reachesRequestedExport)) ?? []
            const direct = binding?.referencePaths?.some(reachesRequestedExport)
            if (!direct && !selectedNames.length) return
            const selectedName = path.node.init?.type === "MemberExpression"
              ? path.node.init.property?.name ?? path.node.init.property?.value
              : "default"
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- CommonJS member names cross the parser boundary as identifiers or literals.
            if (typeof selectedName === "string" && direct) imports.push({ importedName: selectedName, specifier })
            for (const name of selectedNames) imports.push({ importedName: name, specifier })
          },
        },
      })],
    },
  })
  return imports
}

type InlineWorkspaceStoreOperation =
  | { kind: "spread", localName: string, position: number }
  | { kind: "property", name: string, position: number, value?: string }

function sourceInlineWorkspaceStoreOperations(
  loaded: { file: string, source: string },
  loader: ReturnType<typeof createWorkspaceDefinitionLoader>,
  env: Record<string, string | undefined>,
): InlineWorkspaceStoreOperation[] {
  const operations: InlineWorkspaceStoreOperation[] = []
  loader.transform({
    filename: loaded.file,
    jsx: extname(loaded.file).endsWith("x"),
    source: loaded.source,
    ts: /\.[cm]?tsx?$/.test(loaded.file),
    babel: {
      plugins: [() => ({
        visitor: {
          SpreadElement(path: BabelNodePath) {
            // SAFETY: Babel's SpreadElement visitor guarantees the argument field.
            const argument = (path.node as BabelNode & { argument?: BabelNode }).argument
            if (
              !babelPathBelongsToExportedStore(path)
              || argument?.type !== "Identifier"
              || !argument.name
            ) return
            operations.push({
              kind: "spread",
              localName: argument.name,
              position: (path.node as BabelNode & { start?: number }).start ?? 0,
            })
          },
          ObjectProperty(path: BabelObjectPropertyPath) {
            if (!babelPathBelongsToExportedStore(path)) return
            const name = babelPropertyName(path)
            // SAFETY: Babel's ObjectProperty visitor guarantees the value node shape consumed by the guarded evaluator below.
            const valueNode = path.node.value as BabelNode | undefined
            let value = babelStringValue(valueNode, path)
            if (
              value === undefined
              && valueNode?.type === "MemberExpression"
              && valueNode.object?.type === "MemberExpression"
              && valueNode.object.object?.type === "Identifier"
              && valueNode.object.object.name === "process"
              && valueNode.object.property?.type === "Identifier"
              && valueNode.object.property.name === "env"
            ) {
              const key = valueNode.property?.name ?? valueNode.property?.value
              // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Environment member keys cross the parser boundary.
              if (typeof key === "string") value = env[key]
            }
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Parsed property names and values cross the Babel boundary as unknown values.
            if (typeof name === "string") {
              operations.push({
                kind: "property",
                name,
                position: (path.node as BabelNode & { start?: number }).start ?? 0,
                value: typeof value === "string" ? value : undefined,
              })
            }
          },
        },
      })],
    },
  })
  return operations.sort((left, right) => left.position - right.position)
}

async function loadFactoredCloudflareArtifactStore(
  definition: DiscoveredWorkspaceDefinition,
  loader: ReturnType<typeof createWorkspaceDefinitionLoader>,
  resolveModule?: SourceModuleResolver,
  env: Record<string, string | undefined> = process.env,
): Promise<WorkspaceDefinitionInput["store"] | undefined> {
  const loaded = await readSourceModule(definition.path)
  if (!loaded) return
  const operations = sourceInlineWorkspaceStoreOperations(loaded, loader, env)
  for (const { importedName, localName, selectedName, specifier } of sourceImportsFeedingWorkspaceStore(loaded, loader, "default")) {
    if (!importedName) continue
    const resolvedModule = specifier.startsWith(".")
      ? resolve(dirname(loaded.file), specifier)
      : await resolveModule?.(specifier, loaded.file)
    if (!resolvedModule) continue
    try {
      // SAFETY: Jiti has no generic import contract; the record guard below validates the module namespace before access.
      const imported = await loader.import(resolvedModule.split(/[?#]/, 1)[0]) as Record<string, unknown>
      const sourceExport = importedName === "default" ? imported.default : imported[importedName]
      const store = selectedName && isRecord(sourceExport) ? sourceExport[selectedName] : sourceExport
      // SAFETY: The provider check establishes the Workspace store variant consumed by normalization.
      if (isRecord(store) && store.provider === "cloudflare-artifacts") {
        // SAFETY: The record and provider guards above establish the Cloudflare Artifacts store variant.
        if (!operations.length) return store as WorkspaceDefinitionInput["store"]
        const reconstructed: Record<string, unknown> = {}
        for (const operation of operations) {
          if (operation.kind === "spread") {
            if (operation.localName !== localName) return
            Object.assign(reconstructed, store)
            continue
          }
          if (operation.value === undefined) return
          reconstructed[operation.name] = operation.value
        }
        if (reconstructed.provider !== "cloudflare-artifacts") return
        // SAFETY: Reconstruction accepts only string properties and requires the Cloudflare Artifacts provider discriminator.
        return reconstructed as WorkspaceDefinitionInput["store"]
      }
    }
    catch {}
  }
}

function vercelFunctionRuntimePackages() {
  return [
    { name: WORKSPACE_PACKAGE_NAME, resolveFrom: import.meta.url },
  ]
}

type CloudflareArtifactsWranglerConfig = {
  artifacts: Array<{ binding: string, namespace: string }>
}

type ConfiguredCloudflareArtifact = Record<string, unknown> & { binding: string }

function cloudflareArtifactsBindingsFile(rootDir: string): string {
  return resolve(createDefaultCloudflareOutputRoot(rootDir), cloudflareArtifactsBindingsFileName)
}

function cloudflareWranglerFile(rootDir: string): string {
  return resolve(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json")
}

function hasCloudflareArtifactBinding(value: unknown): value is ConfiguredCloudflareArtifact {
  return isRecord(value) && typeof value.binding === "string"
}

async function readConfiguredCloudflareArtifacts(rootDir: string): Promise<ConfiguredCloudflareArtifact[]> {
  try {
    const parsed = JSON.parse(await readFile(cloudflareWranglerFile(rootDir), "utf8"))
    if (!isRecord(parsed) || !Array.isArray(parsed.artifacts)) return []
    return parsed.artifacts.filter(hasCloudflareArtifactBinding)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function readOwnedCloudflareArtifactsBindings(rootDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(cloudflareArtifactsBindingsFile(rootDir), "utf8"))
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === "string") : []
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function writeOwnedCloudflareArtifactsBindings(rootDir: string, bindings: string[]): Promise<void> {
  const file = cloudflareArtifactsBindingsFile(rootDir)
  if (!bindings.length) {
    await rm(file, { force: true })
    return
  }
  await mkdir(createDefaultCloudflareOutputRoot(rootDir), { recursive: true })
  await writeFile(file, `${JSON.stringify([...new Set(bindings)], null, 2)}\n`, "utf8")
}

function createCloudflareArtifactsWranglerConfig(configs: ResolvedWorkspaceModuleOptions[]): CloudflareArtifactsWranglerConfig | undefined {
  const target: { cloudflare?: { wrangler?: { artifacts?: Array<{ binding: string, namespace: string }> } } } = {}
  for (const config of configs) configureCloudflareArtifacts(target, config)
  const artifacts = target.cloudflare?.wrangler?.artifacts
  return artifacts?.length ? { artifacts } : undefined
}

function resolveOwnedCloudflareArtifacts(
  requested: CloudflareArtifactsWranglerConfig["artifacts"],
  configured: ConfiguredCloudflareArtifact[],
  previousBindings: string[],
): CloudflareArtifactsWranglerConfig["artifacts"] {
  const previous = new Set(previousBindings)
  return requested.filter((artifact) => {
    if (previous.has(artifact.binding)) return true
    const existing = configured.filter(entry => entry.binding === artifact.binding)
    const collision = existing.find(entry => entry.namespace !== artifact.namespace)
    if (collision) {
      throw new TypeError(`[vitehub] Cloudflare Artifacts binding "${artifact.binding}" already exists in Wrangler config with namespace ${JSON.stringify(collision.namespace)}, but Workspace requested namespace "${artifact.namespace}". Configure a unique binding or use the existing namespace.`)
    }
    return existing.length === 0
  })
}

async function resolveDefinitionCloudflareArtifactsConfigs(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: ResolvedWorkspaceModuleOptions,
  resolveModule?: SourceModuleResolver,
  aliases?: Record<string, string>,
  inspection?: { artifactsOnly?: boolean },
  resolution?: { env?: Record<string, string | undefined>, hosting?: string },
  definitionOverrides?: Map<string, ResolvedWorkspaceModuleOptions>,
): Promise<ResolvedWorkspaceModuleOptions[]> {
  const loader = createWorkspaceDefinitionLoader(rootDir, aliases)
  const sourceModuleResolver = createSourceModuleResolver(rootDir, aliases, resolveModule)
  const configs: ResolvedWorkspaceModuleOptions[] = []
  for (const definition of definitions) {
    if (!inspection?.artifactsOnly && !await sourceModuleMayUseCloudflareArtifacts(definition.path, loader, sourceModuleResolver)) continue
    let loaded: WorkspaceDefinitionInput
    try {
      loaded = await loadDiscoveredWorkspaceDefinition(loader, definition)
      const commonJsLoaded: WorkspaceDefinitionInput & { default?: WorkspaceDefinitionInput } = loaded
      loaded = commonJsLoaded.default ?? loaded
    }
    catch (error) {
      if (inspection?.artifactsOnly && !await sourceModuleMayUseCloudflareArtifacts(definition.path, loader, sourceModuleResolver)) continue
      const store = inspection?.artifactsOnly
        ? await loadFactoredCloudflareArtifactStore(definition, loader, sourceModuleResolver, resolution?.env || process.env)
        : undefined
      if (!store) {
        if (inspection?.artifactsOnly) continue
        throw error
      }
      loaded = { store }
    }
    const workspace = normalizeWorkspaceDefinition(definition.name, loaded)
    if (!workspace.store || "readFile" in workspace.store) continue
    const config = normalizeWorkspaceOptions({ store: workspace.store }, {
      dev: false,
      env: resolution?.env || process.env,
      hosting: resolution?.hosting ?? process.env.VITEHUB_HOSTING,
      rootDir: workspace.rootDir || rootDir,
    })
    if (config && config.store.provider === "cloudflare-artifacts") {
      configs.push(config)
      definitionOverrides?.set(definition.name, config)
    }
  }
  return configs
}

async function resolveCloudflareArtifactsConfigs(
  config: ResolvedWorkspaceModuleOptions,
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: {
    aliases?: Record<string, string>
    artifactsOnly?: boolean
    env?: Record<string, string | undefined>
    hosting?: string
    resolveModule?: SourceModuleResolver
    definitionOverrides?: Map<string, ResolvedWorkspaceModuleOptions>
  } = {},
): Promise<ResolvedWorkspaceModuleOptions[]> {
  return [
    ...(config.store.provider === "cloudflare-artifacts" ? [config] : []),
    ...await resolveDefinitionCloudflareArtifactsConfigs(
      definitions,
      rootDir,
      config,
      options.resolveModule,
      options.aliases,
      { artifactsOnly: options.artifactsOnly },
      { env: options.env, hosting: options.hosting },
      options.definitionOverrides,
    ),
  ]
}

async function writeCloudflareArtifactsProviderOutput(
  rootDir: string,
  config: false | ResolvedWorkspaceModuleOptions,
  definitions: DiscoveredWorkspaceDefinition[],
  resolveModule?: SourceModuleResolver,
  aliases?: Record<string, string>,
): Promise<void> {
  const configs = config
    ? await resolveCloudflareArtifactsConfigs(config, definitions, rootDir, { aliases, resolveModule })
    : []
  const requestedConfig = createCloudflareArtifactsWranglerConfig(configs)
  const [configuredArtifacts, previousBindings] = await Promise.all([
    readConfiguredCloudflareArtifacts(rootDir),
    readOwnedCloudflareArtifactsBindings(rootDir),
  ])
  const ownedArtifacts = resolveOwnedCloudflareArtifacts(requestedConfig?.artifacts ?? [], configuredArtifacts, previousBindings)
  const wranglerConfig = ownedArtifacts.length ? { artifacts: ownedArtifacts } : undefined
  const nextBindings = ownedArtifacts.map(binding => binding.binding)
  if (!wranglerConfig && !previousBindings.length) return

  await writeCloudflareWranglerConfig({
    rootDir,
    wranglerConfigOwnership: {
      arrays: {
        artifacts: {
          key: "binding",
          values: [...previousBindings, ...nextBindings],
        },
      },
    },
    ...(wranglerConfig ? { wranglerConfig } : {}),
  })
  await writeOwnedCloudflareArtifactsBindings(rootDir, nextBindings)
}

export interface WorkspaceNitroConfigOptions {
  aliases?: Record<string, string>
  command?: "build" | "serve"
  env?: Record<string, string | undefined>
  hosting?: string
  nitro?: unknown
  viteRoot?: string
  workspace?: false | WorkspaceModuleOptions
}

export type NitroConfig = {
  cloudflare?: {
    wrangler?: {
      artifacts?: Array<{ binding: string, namespace: string }>
      compatibility_flags?: string[]
    } & Record<string, unknown>
  } & Record<string, unknown>
  plugins?: unknown[]
  rollupConfig?: {
    external?: unknown
  } & Record<string, unknown>
} & Record<string, unknown>

type ViteConfigWithWorkspaceNitro = Omit<UserConfig, "plugins"> & {
  nitro?: NitroConfig
}

function resolveWorkspaceHosting(
  hosting: string | undefined,
  nitro: unknown,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const preset = isRecord(nitro) && typeof nitro.preset === "string" ? nitro.preset : undefined
  return [hosting, preset, env.NITRO_PRESET, env.SERVER_PRESET, env.VITEHUB_HOSTING]
    .map(value => value?.trim())
    .find(Boolean)
}

type WorkspacePluginRoots = {
  projectRoot: string
  viteRoot: string
}

function mergeDedupe(current: string[] | undefined): string[] {
  if (!current) return [WORKSPACE_PACKAGE_NAME]
  return current.includes(WORKSPACE_PACKAGE_NAME) ? current : [...current, WORKSPACE_PACKAGE_NAME]
}

function isWorkspaceFile(file: string) {
  return workspaceSuffixPattern.test(file) || workspacesDirSegment.test(file)
}

function resolveWorkspacePluginRoots(root: string, workspaceOptions: false | WorkspaceModuleOptions | undefined): WorkspacePluginRoots {
  const resolvedViteRoot = resolve(root)
  const resolvedProjectRoot = resolveViteHubProjectRoot(resolvedViteRoot, {
    projectRoot: workspaceOptions ? workspaceOptions.projectRoot : undefined,
  })
  return { projectRoot: resolvedProjectRoot, viteRoot: resolvedViteRoot }
}

function discoverDefinitions(roots: WorkspacePluginRoots, serverDirs?: string[]) {
  return discoverViteWorkspaceDefinitions(roots.viteRoot, { serverDirs, serverRootDir: roots.projectRoot })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isWorkspaceRegistry(value: unknown): value is Record<string, () => Promise<{ default?: unknown }>> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "function")
}

function workspaceDefinitionLoaderAliases(aliases: AliasOptions): Record<string, string> {
  if (!Array.isArray(aliases)) return aliases as Record<string, string>
  return Object.fromEntries(aliases.flatMap(alias =>
    typeof alias.find === "string" ? [[alias.find, alias.replacement]] : [],
  ))
}

function isHostedWorkspaceStore(store: ResolvedWorkspaceModuleOptions["store"]): boolean {
  return store.provider === "cloudflare-artifacts" || store.provider === "github" || store.provider === "vercel-blob"
}

function requestOrigin(server: ViteDevServer, req: IncomingMessage): string {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  if (host) {
    const fallback = server.resolvedUrls?.local?.[0] || "http://localhost/"
    return new URL(`${new URL(fallback).protocol}//${host}`).origin
  }
  const base = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port || 5173}/`
  return new URL(base).origin
}

function validateWorkspaceDevRequest(server: ViteDevServer, req: IncomingMessage): Response | undefined {
  const header = req.headers[workspaceDevHeader]
  if ((Array.isArray(header) ? header[0] : header) !== workspaceDevHeaderValue) {
    return new Response("Forbidden Workspace Dev request.", { status: 403 })
  }
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  if (origin && origin !== requestOrigin(server, req)) {
    return new Response("Forbidden Workspace Dev origin.", { status: 403 })
  }
  if (req.method !== "POST") return
  const contentType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"]
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return new Response("Workspace Dev requests must use application/json.", { status: 415 })
  }
}

function acceptsWorkspaceDevStream(req: IncomingMessage): boolean {
  const accept = Array.isArray(req.headers.accept) ? req.headers.accept.join(",") : req.headers.accept
  return Boolean(accept?.includes("application/x-ndjson"))
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = ""
  req.setEncoding("utf8")
  for await (const chunk of req) body += chunk
  return body
}

function createAbortSignalFromClose(target: Pick<ServerResponse, "off" | "once">, message: string): { dispose: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error(message))
  target.once("close", abort)
  return {
    dispose: () => target.off("close", abort),
    signal: controller.signal,
  }
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  }
  finally {
    reader.releaseLock()
  }
}

function isWorkspaceDevRoute(req: IncomingMessage): boolean {
  return new URL(req.url || "/", "http://localhost").pathname === workspaceDevRoute
}

function streamWorkspaceDevCommand(input: Parameters<typeof runWorkspaceDevCommand>[0], closeHost: () => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const write = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
      try {
        const result = await runWorkspaceDevCommand({
          ...input,
          onProgress: async event => write({ event, type: "progress" }),
        })
        write({ result, type: "result" })
      }
      catch (error) {
        write({ error: error instanceof Error ? error.message : String(error), type: "error" })
      }
      finally {
        await closeHost()
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  })
}

async function handleWorkspaceDevRequest(server: ViteDevServer, req: IncomingMessage, workspaces: Array<{ name: string }>, tokenOptions: WorkspaceDevTokenOptions, abortSignal?: AbortSignal): Promise<Response> {
  const validation = validateWorkspaceDevRequest(server, req)
  if (validation) return validation
  if (req.method === "GET") {
    await ensureWorkspaceDevToken(server.config.root, tokenOptions)
    return Response.json({
      root: server.config.root,
      workspaceDevTokenServerId: tokenOptions.serverId,
      workspaces,
    })
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 })

  let body: { workspaceCommand?: { args?: unknown, command?: unknown, paths?: unknown, timeout?: unknown, workspace?: unknown } }
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body
  }
  catch {
    return new Response("Malformed Workspace Dev payload.", { status: 400 })
  }
  const command = body.workspaceCommand
  if (!command || typeof command.workspace !== "string" || typeof command.command !== "string") {
    return new Response("Missing Workspace Dev command.", { status: 400 })
  }
  if (!await validateWorkspaceDevToken(server.config.root, req.headers, tokenOptions)) {
    return new Response("Forbidden Workspace Dev token.", { status: 403 })
  }
  const mod = await server.ssrLoadModule(WORKSPACE_REGISTRY_ID) as { default?: unknown }
  const registry = isWorkspaceRegistry(mod.default) ? mod.default : {}
  const load = registry[command.workspace]
  if (!load) return new Response(`Unknown Workspace Dev target: ${command.workspace}`, { status: 404 })
  const definition = (await load()).default
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string"))) {
    return new Response("Workspace Dev command args must be strings.", { status: 400 })
  }
  if (command.paths !== undefined && (!Array.isArray(command.paths) || command.paths.some(path => typeof path !== "string"))) {
    return new Response("Workspace Dev command paths must be strings.", { status: 400 })
  }
  const args = command.args as string[] | undefined
  const paths = command.paths as string[] | undefined
  const timeout = typeof command.timeout === "number" && Number.isFinite(command.timeout) ? command.timeout : undefined
  // Keep the dev-only runtime out of provider output tracing.
  const { resolveBox } = await import("@vite-hub/" + "box") as typeof import("@vite-hub/box")
  const host = await (await resolveBox({ runtime: "trusted-host" }, {})).open({ signal: abortSignal })
  const input = {
    abortSignal,
    ...(args ? { args } : {}),
    command: command.command,
    host,
    ...(isRecord(definition) ? { definition: normalizeWorkspaceDefinition(command.workspace, definition as never) } : {}),
    ...(paths?.length ? { paths } : {}),
    ...(timeout ? { timeout } : {}),
    workspace: command.workspace,
  }
  if (acceptsWorkspaceDevStream(req)) return streamWorkspaceDevCommand(input, () => host.close())
  try {
    return Response.json(await runWorkspaceDevCommand(input))
  }
  finally {
    await host.close()
  }
}

function hasNitroPlugin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNitroPlugin)
  return isRecord(value) && typeof value.name === "string" && value.name.startsWith("nitro:")
}

function hasNitroConfig(config: UserConfig): boolean {
  return "nitro" in config || hasNitroPlugin(config.plugins)
}

function hasExplicitWorkspaceRuntimeOptions(options: false | WorkspaceModuleOptions | undefined): boolean {
  return Boolean(options && (options.root || options.store))
}

function shouldInstallNitroWorkspacePlugin(
  config: UserConfig,
  options: false | WorkspaceModuleOptions | undefined,
  normalized: ResolvedWorkspaceModuleOptions,
  definitions: DiscoveredWorkspaceDefinition[],
): boolean {
  return isHostedWorkspaceStore(normalized.store)
    || hasExplicitWorkspaceRuntimeOptions(options)
    || (hasNitroConfig(config) && definitions.length > 0)
}

function mergeNitroWorkspaceConfig(value: unknown): NitroConfig {
  const nitro: NitroConfig = isRecord(value) ? { ...value } : {}
  const plugins = Array.isArray(nitro.plugins) ? [...nitro.plugins] : []
  if (!plugins.includes(generatedNitroWorkspacePlugin)) plugins.push(generatedNitroWorkspacePlugin)
  return { ...nitro, plugins }
}

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

function configureCloudflareNitroRuntime(nitro: NitroConfig): void {
  nitro.cloudflare ??= {}
  nitro.cloudflare.wrangler ??= {}
  nitro.cloudflare.nodeCompat = true
  const rollupConfig = isRecord(nitro.rollupConfig) ? { ...nitro.rollupConfig } : {}
  nitro.rollupConfig = { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") }
}

function moduleImportSpecifier(fromFile: string, targetFile: string): string {
  const specifier = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

function shouldConfigureRuntime(options: false | WorkspaceModuleOptions | undefined, normalized: ResolvedWorkspaceModuleOptions): boolean {
  return isHostedWorkspaceStore(normalized.store) || hasExplicitWorkspaceRuntimeOptions(options)
}

function renderRuntimeValue(value: unknown, depth = 0): string {
  if (typeof value === "function") return value.toString()
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    const indent = "  ".repeat(depth + 1)
    const closingIndent = "  ".repeat(depth)
    return `[\n${value.map(item => `${indent}${renderRuntimeValue(item, depth + 1)}`).join(",\n")}\n${closingIndent}]`
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    if (!entries.length) return "{}"
    const indent = "  ".repeat(depth + 1)
    const closingIndent = "  ".repeat(depth)
    return `{\n${entries.map(([key, entry]) => `${indent}${JSON.stringify(key)}: ${renderRuntimeValue(entry, depth + 1)}`).join(",\n")}\n${closingIndent}}`
  }
  return JSON.stringify(value)
}

function runtimeWorkspaceConfig(
  config: false | ResolvedWorkspaceModuleOptions,
  options: false | WorkspaceModuleOptions | undefined,
  cloudflareRuntime: boolean,
): false | ResolvedWorkspaceModuleOptions {
  if (!cloudflareRuntime || !config || config.store.provider !== "github" || !options) return config
  const store = options.store
  if (!store || "readFile" in store || store.provider !== "github") return config
  const runtimeStore = { ...config.store }
  const isAbsent = (value: unknown) => typeof value === "undefined" || (typeof value === "string" && value.trim().length === 0)
  for (const key of ["branch", "root", "token"] as const) {
    if (typeof store[key] === "function") {
      runtimeStore[key] = store[key]
    }
    else if (isAbsent(store[key])) {
      delete runtimeStore[key]
    }
  }
  if (typeof store.repository === "function") {
    runtimeStore.repository = store.repository
  }
  else if (typeof store.repo === "function") {
    runtimeStore.repo = store.repo
    delete runtimeStore.repository
  }
  else if (isAbsent(store.repository) && isAbsent(store.repo)) {
    delete runtimeStore.repository
    delete runtimeStore.repo
  }
  return { ...config, store: runtimeStore }
}

function renderNitroWorkspacePlugin(
  config: false | ResolvedWorkspaceModuleOptions,
  registryImport: string,
  installHostedRuntime: boolean,
  cloudflareRuntime: boolean,
  importBase = WORKSPACE_PACKAGE_NAME,
): string {
  const hostedRuntimeImport = `${importBase}/internal/runtime/hosted`
  const hostedVercelBlobRuntimeImport = `${importBase}/internal/runtime/hosted-vercel-blob`
  const runtimeImport = `${importBase}/runtime`
  const hostedConfig = config && isHostedWorkspaceStore(config.store) ? config : undefined
  const isVercelBlobStore = hostedConfig?.store.provider === "vercel-blob"
  const runtimeImports = hostedConfig
    ? [
        isVercelBlobStore
          ? `import { configureHostedVercelBlobWorkspaceRuntime } from '${hostedVercelBlobRuntimeImport}'`
          : `import { configureHostedWorkspaceRuntime, installHostedWorkspaceRuntime } from '${hostedRuntimeImport}'`,
        isVercelBlobStore
          ? `import { installHostedWorkspaceRuntime } from '${hostedRuntimeImport}'`
          : `import { installHostedVercelBlobWorkspaceRuntime } from '${hostedVercelBlobRuntimeImport}'`,
        `import { setWorkspaceRuntimeRegistry } from '${runtimeImport}'`,
      ]
    : [
        ...(installHostedRuntime ? [`import { installHostedWorkspaceRuntime } from '${hostedRuntimeImport}'`] : []),
        ...(installHostedRuntime ? [`import { installHostedVercelBlobWorkspaceRuntime } from '${hostedVercelBlobRuntimeImport}'`] : []),
        `import { ${config ? "setWorkspaceRuntimeConfig, " : ""}setWorkspaceRuntimeRegistry } from '${runtimeImport}'`,
      ]
  if (cloudflareRuntime) {
    runtimeImports.unshift(
      "import { env as vitehubEnv } from 'cloudflare:workers'",
      `import { setActiveCloudflareEnv } from '${importBase}/internal/runtime/state'`,
    )
  }
  const runtimeSetup = hostedConfig
    ? [
        `  ${isVercelBlobStore ? "configureHostedVercelBlobWorkspaceRuntime" : "configureHostedWorkspaceRuntime"}(${renderRuntimeValue({ root: hostedConfig.root, store: hostedConfig.store })})`,
        `  ${isVercelBlobStore ? "installHostedWorkspaceRuntime" : "installHostedVercelBlobWorkspaceRuntime"}()`,
      ]
    : [
        ...(installHostedRuntime ? ["  installHostedWorkspaceRuntime()"] : []),
        ...(installHostedRuntime ? ["  installHostedVercelBlobWorkspaceRuntime()"] : []),
        ...(config ? [`  setWorkspaceRuntimeConfig(${renderRuntimeValue({ root: config.root, store: config.store })})`] : []),
      ]

  return [
    ...runtimeImports,
    `import registry from ${JSON.stringify(registryImport)}`,
    "",
    "export default function vitehubWorkspacePlugin() {",
    ...(cloudflareRuntime ? ["  setActiveCloudflareEnv(vitehubEnv)"] : []),
    "  setWorkspaceRuntimeRegistry(registry)",
    ...runtimeSetup,
    "}",
    "",
  ].join("\n")
}

async function writeNitroWorkspacePlugin(
  root: string,
  config: false | ResolvedWorkspaceModuleOptions,
  options: false | WorkspaceModuleOptions | undefined,
  definitions: DiscoveredWorkspaceDefinition[],
  cloudflareRuntime = false,
  importBase = WORKSPACE_PACKAGE_NAME,
  definitionOverrides?: Map<string, ResolvedWorkspaceModuleOptions>,
): Promise<void> {
  const pluginFile = resolve(root, generatedNitroWorkspacePlugin)
  const registryFile = resolve(root, generatedNitroWorkspaceRegistry)
  const runtimeConfig = runtimeWorkspaceConfig(config, options, cloudflareRuntime)
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(dirname(registryFile), { recursive: true }),
  ])
  await writeFile(registryFile, createWorkspaceRegistryContents(registryFile, definitions, definitionOverrides), "utf8")
  await writeFile(
    pluginFile,
    renderNitroWorkspacePlugin(
      runtimeConfig,
      moduleImportSpecifier(pluginFile, registryFile),
      definitions.length > 0 && !(runtimeConfig && isHostedWorkspaceStore(runtimeConfig.store)),
      cloudflareRuntime,
      importBase,
    ),
    "utf8",
  )
}

export async function createWorkspaceNitroConfig(options: WorkspaceNitroConfigOptions = {}): Promise<NitroConfig | null> {
  const workspaceOptions = stripWorkspaceInternalOptions(options.workspace)
  const roots = resolveWorkspacePluginRoots(options.viteRoot || process.cwd(), workspaceOptions)
  const env = options.env || process.env
  const hosting = resolveWorkspaceHosting(options.hosting, options.nitro, env)
  const normalized = normalizeWorkspaceOptions(workspaceOptions, {
    dev: options.command !== "build",
    env,
    hosting,
    rootDir: roots.projectRoot,
  })
  if (!normalized) return null

  const definitions = discoverDefinitions(roots)
  if (!isHostedWorkspaceStore(normalized.store) && !hasExplicitWorkspaceRuntimeOptions(workspaceOptions) && definitions.length === 0) return null

  const definitionOverrides = new Map<string, ResolvedWorkspaceModuleOptions>()
  const cloudflareArtifactsConfigs = await resolveCloudflareArtifactsConfigs(normalized, definitions, roots.projectRoot, {
    aliases: options.aliases,
    artifactsOnly: true,
    env: options.env,
    hosting,
    definitionOverrides,
  })
  const runtimeConfig = shouldConfigureRuntime(workspaceOptions, normalized) ? normalized : false
  const cloudflareRuntime = cloudflareArtifactsConfigs.length > 0 || getHostingProvider(hosting) === "cloudflare"
  await writeNitroWorkspacePlugin(roots.projectRoot, runtimeConfig, workspaceOptions, definitions, cloudflareRuntime, WORKSPACE_PACKAGE_NAME, definitionOverrides)
  const nitro = mergeNitroWorkspaceConfig(options.nitro)
  for (const config of cloudflareArtifactsConfigs) configureCloudflareArtifacts(nitro, config)
  if (cloudflareRuntime) configureCloudflareNitroRuntime(nitro)
  return nitro
}

export interface WorkspaceVitePluginAPI {
  getWorkspaces: () => Array<{ name: string }>
}

interface WorkspaceCliContributingPlugin {
  vitehub?: { cli?: () => unknown | Promise<unknown> }
}

const setWorkspacePluginHosting: unique symbol = Symbol("vitehub.workspace.setHosting")

type WorkspacePluginHosting = string | (() => string | undefined)

export type WorkspaceVitePlugin = Plugin & WorkspaceCliContributingPlugin & {
  [setWorkspacePluginHosting]?: (hosting: WorkspacePluginHosting) => void
  api: WorkspaceVitePluginAPI
}

export function setWorkspaceVitePluginHosting(plugin: unknown, hosting: WorkspacePluginHosting): boolean {
  if (!plugin || typeof plugin !== "object") return false
  const setter = (plugin as WorkspaceVitePlugin)[setWorkspacePluginHosting]
  if (!setter) return false
  setter(hosting)
  return true
}

interface InternalWorkspaceModuleOptions extends WorkspaceModuleOptions {
  hosting?: WorkspacePluginHosting
  importBase?: string
}

function stripWorkspaceInternalOptions(options: false | WorkspaceModuleOptions | undefined): false | WorkspaceModuleOptions | undefined {
  if (!options || (!Object.hasOwn(options, "hosting") && !Object.hasOwn(options, "importBase"))) return options
  const publicOptions = { ...options } as InternalWorkspaceModuleOptions
  delete publicOptions.hosting
  delete publicOptions.importBase
  return publicOptions
}

export function hubWorkspace(options?: WorkspaceModuleOptions): WorkspaceVitePlugin {
  let hosting = (options as InternalWorkspaceModuleOptions | undefined)?.hosting
  const importBase = (options as InternalWorkspaceModuleOptions | undefined)?.importBase ?? WORKSPACE_PACKAGE_NAME
  const publicOptions = stripWorkspaceInternalOptions(options)
  let resolved: ResolvedConfig | undefined
  let resolvedOptions: ReturnType<typeof normalizeWorkspaceOptions> = false
  let projectRoot: string | undefined
  let viteRoot: string | undefined
  let assetsRegistryFile: string | undefined
  let manifest: WorkspaceBuildState["manifest"] = { workspaces: [] }
  let registryContents = "export default {}\n"
  let server: ViteDevServer | undefined
  let serverDirs: string[] | undefined

  async function refreshManifest(roots: WorkspacePluginRoots) {
    const definitions = discoverDefinitions(roots, serverDirs)
    const state = await refreshWorkspaceBuildState(roots.projectRoot, definitions)
    manifest = state.manifest
    registryContents = state.registryContents
  }

  function invalidateVirtualWorkspaceModules() {
    if (!server) return
    const moduleGraph = server.moduleGraph
    const ids = [RESOLVED_WORKSPACE_REGISTRY_ID, RESOLVED_WORKSPACES_ID, ...manifest.workspaces.map(w => `${RESOLVED_WORKSPACE_PREFIX}${w.name}`)]
    for (const id of ids) {
      const mod = moduleGraph.getModuleById(id)
      if (mod) moduleGraph.invalidateModule(mod)
    }
  }

  async function maybeRefreshTypesForFile(roots: WorkspacePluginRoots, file: string) {
    if (!isWorkspaceFile(file)) return
    await refreshManifest(roots)
    invalidateVirtualWorkspaceModules()
  }

  return {
    name: "@vite-hub/workspace/vite",
    enforce: "pre",
    [setWorkspacePluginHosting](value) {
      hosting = value
    },
    api: {
      getWorkspaces: () => manifest.workspaces,
    },
    async config(config, env) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const workspaceOptions = stripWorkspaceInternalOptions(
        (config as UserConfig & { workspace?: false | WorkspaceModuleOptions }).workspace ?? publicOptions,
      )
      const roots = resolveWorkspacePluginRoots(config.root || process.cwd(), workspaceOptions)
      const resolvedHosting = resolveWorkspaceHosting(
        typeof hosting === "function" ? hosting() : hosting,
        (config as ViteConfigWithWorkspaceNitro).nitro,
      )
      const normalized = normalizeWorkspaceOptions(workspaceOptions, {
        dev: env?.command !== "build",
        env: process.env,
        hosting: resolvedHosting,
        rootDir: roots.projectRoot,
      })
      const runtimeOptions = resolvedHosting && normalized && normalized.store.provider !== "local"
        ? { ...(workspaceOptions || {}), store: workspaceOptions && workspaceOptions.store ? workspaceOptions.store : normalized.store }
        : workspaceOptions
      const viteConfig: ViteConfigWithWorkspaceNitro = {
        server: {
          watch: {
            ignored: mergeGeneratedViteHubWatchIgnored(config.server?.watch?.ignored),
          },
        },
      }
      const definitions = normalized ? discoverDefinitions(roots, serverDirs) : []
      if (normalized && shouldInstallNitroWorkspacePlugin(config, runtimeOptions, normalized, definitions)) {
        const runtimeConfig = shouldConfigureRuntime(runtimeOptions, normalized) ? normalized : false
        const definitionOverrides = new Map<string, ResolvedWorkspaceModuleOptions>()
        const artifacts = await resolveCloudflareArtifactsConfigs(normalized, definitions, roots.projectRoot, {
          aliases: config.resolve?.alias ? workspaceDefinitionLoaderAliases(config.resolve.alias) : undefined,
          artifactsOnly: true,
          hosting: resolvedHosting,
          definitionOverrides,
        })
        const usesCloudflareArtifacts = artifacts.length > 0
        const usesCloudflareRuntime = usesCloudflareArtifacts || getHostingProvider(resolvedHosting) === "cloudflare"
        await writeNitroWorkspacePlugin(roots.projectRoot, runtimeConfig, runtimeOptions, definitions, usesCloudflareRuntime, importBase, definitionOverrides)
        const nitro = mergeNitroWorkspaceConfig((config as ViteConfigWithWorkspaceNitro).nitro)
        for (const artifactConfig of artifacts) configureCloudflareArtifacts(nitro, artifactConfig)
        if (usesCloudflareRuntime) configureCloudflareNitroRuntime(nitro)
        ;(config as ViteConfigWithWorkspaceNitro).nitro = nitro
        viteConfig.nitro = nitro
      }
      return viteConfig
    },
    async configResolved(config) {
      resolved = config
      const workspaceOptions = stripWorkspaceInternalOptions(
        (config as ResolvedConfig & { workspace?: false | WorkspaceModuleOptions }).workspace ?? publicOptions,
      )
      const roots = resolveWorkspacePluginRoots(config.root, workspaceOptions)
      projectRoot = roots.projectRoot
      viteRoot = roots.viteRoot
      const resolvedHosting = resolveWorkspaceHosting(
        typeof hosting === "function" ? hosting() : hosting,
        (config as ResolvedConfig & { nitro?: NitroConfig }).nitro,
      )
      if (config.command !== "build")
        process.env.VITEHUB_WORKSPACE_DEV = "true"
      else
        delete process.env.VITEHUB_WORKSPACE_DEV
      resolvedOptions = normalizeWorkspaceOptions(workspaceOptions, {
        dev: config.command !== "build",
        env: process.env,
        hosting: resolvedHosting,
        rootDir: roots.projectRoot,
      })
      assetsRegistryFile = resolve(roots.projectRoot, ".vitehub/vite-runtime/workspace/assets/registry.mjs")
      await initializeWorkspaceAssetRegistry(assetsRegistryFile)
      await refreshManifest(roots)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: {
          dedupe: mergeDedupe(config.resolve?.dedupe),
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    async buildStart() {
      if (!resolved) return
      const roots = {
        projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
        viteRoot: viteRoot || resolve(resolved.root),
      }
      await refreshManifest(roots)
      if (resolved.command !== "build" || !assetsRegistryFile) return

      const definitions = discoverDefinitions(roots, serverDirs)
      await syncWorkspaceBuildAssets(definitions, roots.projectRoot, resolvedOptions, assetsRegistryFile)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        const roots = {
          projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
          viteRoot: viteRoot || resolve(resolved.root),
        }
        const definitions = discoverDefinitions(roots, serverDirs)
        await Promise.all(definitions.map(async (definition) => {
          definition.source = await readFile(definition.path, "utf8")
        }))
        await Promise.all([
          copyVercelFunctionRuntimePackages({
            packages: vercelFunctionRuntimePackages(),
            rootDir: roots.projectRoot,
          }),
          writeCloudflareArtifactsProviderOutput(
            roots.projectRoot,
            resolvedOptions,
            definitions,
            resolved.createResolver?.(),
            resolved.resolve ? workspaceDefinitionLoaderAliases(resolved.resolve.alias) : undefined,
          ),
        ])
      },
    },
    async configureServer(devServer) {
      server = devServer
      installHostedWorkspaceRuntime()
      installHostedVercelBlobWorkspaceRuntime()
      const tokenOptions = { serverId: workspaceDevTokenServerId(devServer.config.server.port) }
      await refreshWorkspaceDevToken(devServer.config.root, tokenOptions)
      const roots = {
        projectRoot: projectRoot || resolveViteHubProjectRoot(devServer.config.root),
        viteRoot: viteRoot || resolve(devServer.config.root),
      }
      const refresh = async (file: string) => await maybeRefreshTypesForFile(roots, file)
      devServer.watcher.on("add", refresh)
      devServer.watcher.on("unlink", refresh)
      devServer.middlewares.use((req, res, next) => {
        if (!isWorkspaceDevRoute(req)) return next()
        const abort = createAbortSignalFromClose(res, "[vitehub] Workspace Dev response closed.")
        void handleWorkspaceDevRequest(devServer, req, manifest.workspaces, tokenOptions, abort.signal)
          .then(response => writeResponse(res, response))
          .catch((error: unknown) => writeResponse(res, new Response(error instanceof Error ? error.message : "Workspace Dev request failed.", { status: 500 })))
          .finally(abort.dispose)
      })
    },
    vitehub: {
      cli: async () => {
        return createWorkspaceCliContributor()
      },
    },
    async handleHotUpdate(ctx: HmrContext) {
      if (!resolved) return
      await maybeRefreshTypesForFile({
        projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
        viteRoot: viteRoot || resolve(resolved.root),
      }, ctx.file)
    },
    resolveId(id) {
      if (id === WORKSPACE_ASSETS_REGISTRY_ID) return assetsRegistryFile
      if (id === WORKSPACE_REGISTRY_ID) return RESOLVED_WORKSPACE_REGISTRY_ID
      if (id === WORKSPACES_ID) return RESOLVED_WORKSPACES_ID
      if (id.startsWith(WORKSPACE_PREFIX)) return `${RESOLVED_WORKSPACE_PREFIX}${id.slice(WORKSPACE_PREFIX.length)}`
    },
    load(id) {
      if (id === RESOLVED_WORKSPACE_REGISTRY_ID) return registryContents
      if (id === RESOLVED_WORKSPACES_ID) {
        return `export const workspaces = ${JSON.stringify(manifest.workspaces)};\nexport default { workspaces };\n`
      }
      if (id.startsWith(RESOLVED_WORKSPACE_PREFIX)) {
        const name = id.slice(RESOLVED_WORKSPACE_PREFIX.length)
        const workspace = manifest.workspaces.find(item => item.name === name)
        return `const manifest = ${JSON.stringify(workspace ? { ...workspace, entries: [] } : { name, entries: [] })};\nexport default manifest;\n`
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workspace?: false | WorkspaceModuleOptions
  }
}
