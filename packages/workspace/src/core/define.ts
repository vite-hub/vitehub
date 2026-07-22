import type { WorkspaceDefinitionInput } from "./types.ts"

const workspaceDefinitionKeys = new Set([
  "bindings",
  "commit",
  "hooks",
  "loaders",
  "plugins",
  "publish",
  "rootDir",
  "rules",
  "sourceRootDir",
  "sources",
  "store",
])

function assertWorkspaceDefinitionKeys(definition: WorkspaceDefinitionInput): void {
  const unsupported = Object.keys(definition).filter(key => !workspaceDefinitionKeys.has(key))
  if (!unsupported.length) return
  throw new TypeError(`[vitehub] defineWorkspace does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`)
}

export function defineWorkspace(definition: WorkspaceDefinitionInput): WorkspaceDefinitionInput {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("[vitehub] defineWorkspace requires a workspace definition.")
  }
  if ("name" in definition) {
    throw new TypeError("[vitehub] Workspace names are inferred from definition filenames.")
  }
  assertWorkspaceDefinitionKeys(definition)
  return definition
}
