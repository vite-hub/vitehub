import { normalizeWorkspacePath } from "./path.ts"

import type { WorkspaceSearchHit, WorkspaceSearchQuery } from "./types.ts"

export function toSearchRegExp(query: WorkspaceSearchQuery): RegExp {
  const source = query.regex ? query.pattern : escapeRegExp(query.pattern)
  return new RegExp(source, query.caseSensitive ? "g" : "gi")
}

export function searchText(path: string, content: string, query: WorkspaceSearchQuery): WorkspaceSearchHit[] {
  const result: WorkspaceSearchHit[] = []
  const expression = toSearchRegExp(query)
  const lines = content.split(/\r?\n/)
  const limit = query.limit ?? 100

  for (let index = 0; index < lines.length && result.length < limit; index++) {
    const line = lines[index]
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
  }

  return result
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
