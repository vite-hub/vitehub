import { existsSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createRuntimeRegistryContents, discoverDefinitions, normalizePathDefinitionName, normalizeSuffixDefinitionName } from "@vitehub/internal/definition-catalog"
import type { DefinitionCatalogSource } from "@vitehub/internal/definition-catalog"

export interface DiscoveredWorkspaceDefinition {
  handler: string
  name: string
  path: string
  source?: string
}

const workspaceSuffixPattern = /\.workspace\.(?:c|m)?[jt]s$/i
const workspaceConfigPattern = /^\.config\.(?:c|m)?[jt]s$/i
const workspaceConfigFileNames = [".config.ts", ".config.mts", ".config.cts", ".config.js", ".config.mjs", ".config.cjs"]
type WorkspaceDefinitionCatalogSource = DefinitionCatalogSource<DiscoveredWorkspaceDefinition>

function hasWorkspaceDirectoryConfig(directory: string) {
  return workspaceConfigFileNames.some(file => existsSync(join(directory, file)))
}

function normalizeNitroDirectoryWorkspaceName(workspacesDir: string, file: string) {
  if (!workspaceConfigPattern.test(basename(file))) return
  const name = relative(workspacesDir, dirname(file)).replace(/\\/g, "/")
  return name && name !== "." ? name : undefined
}

function isNestedInsideDirectoryWorkspace(workspacesDir: string, file: string) {
  const relativeDirectory = relative(workspacesDir, dirname(file)).replace(/\\/g, "/")
  if (!relativeDirectory || relativeDirectory === ".") return false

  let current = workspacesDir
  for (const segment of relativeDirectory.split("/")) {
    current = join(current, segment)
    if (hasWorkspaceDirectoryConfig(current)) {
      return true
    }
  }

  return false
}

function normalizeNitroFlatWorkspaceName(workspacesDir: string, file: string) {
  if (workspaceConfigPattern.test(basename(file))) return
  if (isNestedInsideDirectoryWorkspace(workspacesDir, file)) return

  return normalizePathDefinitionName(workspacesDir, file)
}

function nitroWorkspaceSource(rootDir: string): WorkspaceDefinitionCatalogSource[] {
  return [
    {
      kind: "directory",
      includeHidden: true,
      normalizeName: normalizeNitroDirectoryWorkspaceName,
      scanDirs: [resolve(rootDir, "server")],
      source: "nitro-server-workspaces-directory-config",
      subdir: "workspaces",
      createDefinition: ({ file, name }) => ({ handler: file, name, path: file, source: "nitro-server-workspaces-directory-config" }),
    },
    {
      kind: "directory",
      normalizeName: normalizeNitroFlatWorkspaceName,
      scanDirs: [resolve(rootDir, "server")],
      source: "nitro-server-workspaces",
      subdir: "workspaces",
      createDefinition: ({ file, name }) => ({ handler: file, name, path: file, source: "nitro-server-workspaces" }),
    },
  ]
}

function viteWorkspaceSource(rootDir: string): WorkspaceDefinitionCatalogSource[] {
  return [
    {
      kind: "suffix",
      normalizeName: (root, file) => normalizeSuffixDefinitionName(root, file, workspaceSuffixPattern, { stripPrefix: "src/" }),
      pattern: workspaceSuffixPattern,
      roots: [rootDir],
      source: "vite-workspace-suffix",
      createDefinition: ({ file, name }) => ({ handler: file, name, path: file, source: "vite-workspace-suffix" }),
    },
  ]
}

export function discoverNitroWorkspaceDefinitions(rootDir: string): DiscoveredWorkspaceDefinition[] {
  return discoverDefinitions("workspace", [...nitroWorkspaceSource(rootDir)])
}

export function discoverViteWorkspaceDefinitions(rootDir: string): DiscoveredWorkspaceDefinition[] {
  return discoverDefinitions("workspace", [...viteWorkspaceSource(rootDir)])
}

export function createWorkspaceRegistryContents(registryFile: string, definitions: DiscoveredWorkspaceDefinition[]): string {
  return createRuntimeRegistryContents(registryFile, definitions)
}

export function createWorkspaceVirtualRegistryContents(definitions: DiscoveredWorkspaceDefinition[]): string {
  return [
    "const registry = {",
    ...definitions.map(definition => `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(pathToFileURL(definition.path).href)}),`),
    "}",
    "export default registry",
    "",
  ].join("\n")
}

export async function createWorkspaceManifest(definitions: DiscoveredWorkspaceDefinition[]): Promise<{ workspaces: Array<{ name: string }> }> {
  return {
    workspaces: definitions.map(definition => ({ name: definition.name })),
  }
}
