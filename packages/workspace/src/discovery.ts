import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

interface DiscoveredWorkspaceDefinition {
  name: string
  path: string
}

function listDefinitionFiles(dir: string) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => /\.[cm]?[tj]s$/.test(entry.name))
    .map(entry => resolve(dir, entry.name))
}

function definitionName(path: string) {
  return path.split("/").pop()?.replace(/\.[cm]?[tj]s$/, "") || ""
}

export function discoverWorkspaceDefinitions(rootDir: string): DiscoveredWorkspaceDefinition[] {
  const paths = [
    ...listDefinitionFiles(resolve(rootDir, "workspaces")),
    ...listDefinitionFiles(resolve(rootDir, "server/workspaces")),
  ]
  return paths.map(path => ({ name: definitionName(path), path })).sort((a, b) => a.name.localeCompare(b.name))
}

export function createWorkspaceRegistryContents(definitions: DiscoveredWorkspaceDefinition[]): string {
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
