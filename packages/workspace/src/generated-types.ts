import { readdirSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"

const workspaceConfigPattern = /^\.config\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.[cm]?[jt]s$/i

function listDirectoryWorkspaceAssetPaths(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true })
  const assets: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue

    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      assets.push(...listDirectoryWorkspaceAssetPaths(root, path))
      continue
    }

    if (workspaceConfigPattern.test(entry.name) || declarationFilePattern.test(entry.name)) continue
    assets.push(relative(root, path).replace(/\\/g, "/"))
  }

  return assets.sort()
}

function createWorkspaceAssetMap(definitions: Array<{ name: string, path: string }>) {
  return definitions.reduce<Record<string, string[]>>((map, definition) => {
    if (!workspaceConfigPattern.test(basename(definition.path))) return map
    const assets = listDirectoryWorkspaceAssetPaths(dirname(definition.path))
    if (assets.length) map[definition.name] = assets
    return map
  }, {})
}

function toTypeUnion(values: string[]) {
  return values.length ? values.map(value => JSON.stringify(value)).join(" | ") : "never"
}

function createAssetPathType(values: string[]) {
  const known = toTypeUnion(values)
  return values.length ? `${known} | (string & {})` : "string & {}"
}

export function createWorkspaceTypeAugmentation(definitions: Array<{ name: string, path: string }>): string {
  const names = definitions.map(definition => definition.name)
  const nameProperties = [...new Set(names)].sort().map(name => `    ${JSON.stringify(name)}: true`)
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
