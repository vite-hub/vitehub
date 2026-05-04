import { readdirSync } from "node:fs"
import { basename, dirname, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createRuntimeRegistryContents, discoverDefinitions, normalizePathDefinitionName, normalizeSuffixDefinitionName } from "@vitehub/internal/definition-catalog"

import { workspaceConfigFileNames, workspaceConfigPattern, workspaceSuffixPattern } from "./workspace-config.ts"

import type { DefinitionCatalogSource } from "@vitehub/internal/definition-catalog"

export interface DiscoveredWorkspaceDefinition {
  handler: string
  name: string
  path: string
  source?: string
}

type WorkspaceDefinitionCatalogSource = DefinitionCatalogSource<DiscoveredWorkspaceDefinition>

const configFileNameSet = new Set<string>(workspaceConfigFileNames)

function collectDirectoriesWithConfig(root: string): Set<string> {
  const directories = new Set<string>()
  const walk = (current: string) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }

    if (entries.some(entry => entry.isFile() && configFileNameSet.has(entry.name))) {
      directories.add(current.replace(/\\/g, "/"))
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue
      walk(resolve(current, entry.name))
    }
  }
  walk(root)
  return directories
}

function nitroWorkspaceSource(rootDir: string): WorkspaceDefinitionCatalogSource[] {
  const workspacesDir = resolve(rootDir, "server", "workspaces")
  const directoryWorkspaceDirs = collectDirectoriesWithConfig(workspacesDir)

  const normalizeDirectoryName = (workspacesRoot: string, file: string) => {
    if (!workspaceConfigPattern.test(basename(file))) return
    const name = relative(workspacesRoot, dirname(file)).replace(/\\/g, "/")
    return name && name !== "." ? name : undefined
  }

  const isInsideDirectoryWorkspace = (file: string) => {
    let current = dirname(file).replace(/\\/g, "/")
    const stop = workspacesDir.replace(/\\/g, "/")
    while (current.startsWith(stop) && current !== stop) {
      if (directoryWorkspaceDirs.has(current)) return true
      current = dirname(current)
    }
    return false
  }

  const normalizeFlatName = (workspacesRoot: string, file: string) => {
    if (workspaceConfigPattern.test(basename(file))) return
    if (isInsideDirectoryWorkspace(file)) return
    return normalizePathDefinitionName(workspacesRoot, file)
  }

  return [
    {
      kind: "directory",
      includeHidden: true,
      normalizeName: normalizeDirectoryName,
      scanDirs: [resolve(rootDir, "server")],
      source: "nitro-server-workspaces-directory-config",
      subdir: "workspaces",
      createDefinition: ({ file, name }) => ({ handler: file, name, path: file, source: "nitro-server-workspaces-directory-config" }),
    },
    {
      kind: "directory",
      normalizeName: normalizeFlatName,
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
