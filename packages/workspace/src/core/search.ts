import { normalizeWorkspacePath } from "./path.ts"

import type { WorkspaceSearchHit, WorkspaceSearchQuery } from "./types.ts"

function toSearchRegExp(query: WorkspaceSearchQuery): RegExp {
  const source = query.regex ? query.pattern : escapeRegExp(query.pattern)
  return new RegExp(source, query.caseSensitive ? "g" : "gi")
}

export function searchText(path: string, content: string, query: WorkspaceSearchQuery): WorkspaceSearchHit[] {
  const result: WorkspaceSearchHit[] = []
  const expression = toSearchRegExp(query)
  const limit = query.limit ?? 100

  let start = 0
  for (let index = 0; start <= content.length && result.length < limit; index++) {
    const newline = content.indexOf("\n", start)
    const end = newline === -1 ? content.length : newline
    const line = content.slice(start, newline !== -1 && content[end - 1] === "\r" ? end - 1 : end)
    expression.lastIndex = 0
    let match = expression.exec(line)
    while (match && result.length < limit) {
      result.push({
        path: normalizeWorkspacePath(path),
        line: index + 1,
        column: match.index + 1,
        text: line,
      })
      if (!expression.global) break
      if (match[0] === "") expression.lastIndex += 1
      match = expression.exec(line)
    }
    if (newline === -1) break
    start = newline + 1
  }

  return result
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
