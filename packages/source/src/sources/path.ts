import picomatch from "picomatch"

import { normalizeSourcePath } from "../core/path.ts"

export function matchesAny(path: string, patterns?: string | readonly string[]): boolean {
  if (!patterns) return true
  const list = Array.isArray(patterns) ? patterns : [String(patterns)]
  return picomatch.isMatch(
    normalizeSourcePath(path),
    list.map(pattern => normalizeSourcePath(pattern)),
    { dot: true },
  )
}
