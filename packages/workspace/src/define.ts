import type { WorkspaceDefinitionInput } from "./types.ts"

export function defineWorkspace(definition: WorkspaceDefinitionInput): WorkspaceDefinitionInput {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("[vitehub] defineWorkspace requires a workspace definition.")
  }
  if ("name" in definition) {
    throw new TypeError("[vitehub] Workspace names are inferred from definition filenames.")
  }
  return definition
}
