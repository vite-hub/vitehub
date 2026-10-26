import { Minimatch } from "minimatch"

import { normalizeSafeWorkspacePath, normalizeWorkspacePath } from "./path.ts"
import type { GlobOptions } from "./types.ts"

export function createWorkspaceGlobMatcher(pattern: string | string[], options: GlobOptions = {}) {
  const requestedCwd = options.cwd === "." ? "" : options.cwd
  let cwd: string
  try {
    cwd = normalizeSafeWorkspacePath(requestedCwd, { allowEmpty: true })
  }
  catch (error) {
    // Request source descriptors are exposed under this reserved, canonical path.
    // Keep all other reserved paths rejected, including nested .git components.
    const reservedCwd = normalizeSafeWorkspacePath(requestedCwd, { allowEmpty: true, allowReserved: true })
    if (reservedCwd !== ".vitehub/sources") throw error
    cwd = reservedCwd
  }
  const prefix = cwd ? `${cwd}/` : ""
  const matchers = pattern
    ? (Array.isArray(pattern) ? pattern : [pattern]).map(value => new Minimatch(normalizeWorkspacePath(value), { dot: true }))
    : undefined
  return {
    cwd,
    matches(path: string): boolean {
      if (!path.startsWith(prefix)) return false
      const relative = normalizeWorkspacePath(path.slice(prefix.length))
      return !matchers || matchers.some(matcher => matcher.match(relative))
    },
  }
}
