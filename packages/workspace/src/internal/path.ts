import { workspacePathError } from "../core/errors.ts"

export interface SafeWorkspacePathOptions {
  allowEmpty?: boolean
  allowReserved?: boolean
  pattern?: boolean
}

function classifyWindowsComponent(part: string): { normalized: string; isTraversal: boolean } {
  const name = part.toLowerCase()
  const withoutStream = name.split(":", 1)[0]!
  const basename = withoutStream.replace(/[ .]+$/, "")
  return { normalized: basename, isTraversal: /^(?:\.(?: +[. ]*)?|\.\.(?: +[. ]*)?)$/.test(withoutStream) }
}

export function normalizeSafeWorkspacePath(path = "", options: SafeWorkspacePathOptions = {}): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (!options.allowEmpty && !normalized) throw workspacePathError(path)
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw) || raw.includes("\0")) throw workspacePathError(path)
  if (parts.some((part, index) => {
    const name = part.toLowerCase()
    const classification = classifyWindowsComponent(part)
    const reserved = classification.normalized === ".git"
      || /^git~\d+$/.test(classification.normalized)
      || (index === 0 && classification.normalized === ".vitehub")
      || (index === 0 && /^vitehu~\d+$/.test(classification.normalized))
    const canonical = (classification.normalized === ".git" || (index === 0 && classification.normalized === ".vitehub"))
      && name === classification.normalized
    return classification.isTraversal || (reserved && (!options.allowReserved || !canonical))
  })) throw workspacePathError(path)
  return normalized
}
