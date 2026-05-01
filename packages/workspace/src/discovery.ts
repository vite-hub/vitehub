import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createRuntimeRegistryContents, discoverDefinitions, normalizeSuffixDefinitionName } from "@vitehub/internal/definition-catalog"
import type { DefinitionCatalogSource } from "@vitehub/internal/definition-catalog"

export interface DiscoveredWorkspaceDefinition {
  handler: string
  name: string
  path: string
  source?: string
}

const workspaceSuffixPattern = /\.workspace\.(?:c|m)?[jt]s$/i
type WorkspaceDefinitionCatalogSource = DefinitionCatalogSource<DiscoveredWorkspaceDefinition>

function nitroWorkspaceSource(rootDir: string): WorkspaceDefinitionCatalogSource[] {
  return [
    {
      kind: "directory",
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
