// JSON null cannot collide with a named Workspace, whose scope is a JSON string.
export function workspaceMetadataScope(workspaceName: string | undefined) {
  return JSON.stringify(workspaceName ?? null)
}
