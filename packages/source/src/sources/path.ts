import picomatch from "picomatch"

import { normalizeSourcePath } from "../core/path.ts"

export function createPathMatcher(patterns?: string | readonly string[]): (path: string) => boolean {
  if (!patterns) return () => true
  const list = Array.isArray(patterns) ? patterns : [String(patterns)]
  const match = picomatch(
    list.map(pattern => normalizeSourcePath(pattern)),
    { dot: true },
  )
  return path => match(normalizeSourcePath(path))
}

export function matchesAny(path: string, patterns?: string | readonly string[]): boolean {
  return createPathMatcher(patterns)(path)
}
