import { registerWorkspace } from "@vitehub/workspace/test"
import docsWorkspace from "../workspaces/docs"

let registered = false

export function ensureDocsWorkspace() {
  if (registered) return
  registerWorkspace("docs", docsWorkspace)
  registered = true
}
