import { registerWorkspace } from "@vitehub/workspace"
import docsWorkspace from "../../workspaces/docs"

let registered = false

export function ensureDocsWorkspace() {
  if (registered) return
  registerWorkspace(docsWorkspace)
  registered = true
}
