import { basename, dirname, relative } from "node:path"

import { listMatchingFiles } from "@vitehub/internal/definition-catalog"

import { isWorkspaceAssetFile, workspaceConfigPattern } from "./workspace-config.ts"

function listDirectoryWorkspaceAssetPaths(root: string) {
  return listMatchingFiles(root, isWorkspaceAssetFile).map(file => relative(root, file).replace(/\\/g, "/")).sort()
}

function createWorkspaceAssetMap(definitions: Array<{ name: string, path: string }>) {
  const map: Record<string, string[]> = {}
  for (const definition of definitions) {
    if (!workspaceConfigPattern.test(basename(definition.path))) continue
    const assets = listDirectoryWorkspaceAssetPaths(dirname(definition.path))
    if (assets.length) map[definition.name] = assets
  }
  return map
}

function toTypeUnion(values: string[]) {
  return values.length ? values.map(value => JSON.stringify(value)).join(" | ") : "never"
}

function createAssetPathType(values: string[]) {
  const known = toTypeUnion(values)
  return values.length ? `${known} | (string & {})` : "string & {}"
}

export function createWorkspaceTypeAugmentation(definitions: Array<{ name: string, path: string }>): string {
  const names = [...new Set(definitions.map(definition => definition.name))].sort()
  const nameProperties = names.map(name => `    ${JSON.stringify(name)}: true`)
  const assetMap = createWorkspaceAssetMap(definitions)
  const assetProperties = Object.entries(assetMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, assets]) => `    ${JSON.stringify(name)}: ${createAssetPathType(assets)}`)

  return [
    "declare global {",
    "  interface ViteHubWorkspaceNameMap {",
    ...(nameProperties.length ? nameProperties : ["    __vitehub_no_workspaces__?: never"]),
    "  }",
    "",
    "  interface ViteHubWorkspaceAssetMap {",
    ...(assetProperties.length ? assetProperties : ["    __vitehub_no_workspace_assets__?: never"]),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}
