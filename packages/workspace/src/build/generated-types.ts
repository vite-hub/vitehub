export function createWorkspaceTypeAugmentation(definitions: Array<{ name: string, path: string }>): string {
  const names = [...new Set(definitions.map(definition => definition.name))].sort()
  const nameProperties = names.map(name => `    ${JSON.stringify(name)}: true`)

  return [
    "declare global {",
    "  interface ViteHubWorkspaceNameMap {",
    ...(nameProperties.length ? nameProperties : ["    __vitehub_no_workspaces__?: never"]),
    "  }",
    "",
    "  interface ViteHubWorkspaceAssetMap {",
    "    __vitehub_no_workspace_assets__?: never",
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}
