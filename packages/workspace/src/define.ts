import type { WorkspaceDefinition } from "./types.ts"

export function defineWorkspace(definition: WorkspaceDefinition): WorkspaceDefinition {
  if (!definition?.name || typeof definition.name !== "string") {
    throw new TypeError("[vitehub] defineWorkspace requires a string name.")
  }
  return definition
}
