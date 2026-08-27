import { sourceIgnores } from "@vite-hub/source"
import { workspaceError } from "../core/errors.ts"

export function resolveGitHubIgnore(ignore: unknown): string[] | undefined {
  if (ignore === false) return
  if (ignore === undefined) return [...sourceIgnores.defaults]
  const single = runtimeString(ignore)
  if (single !== undefined) return [...sourceIgnores.defaults, single]
  if (!Array.isArray(ignore)) throw invalidGitHubIgnore()
  const parsed: string[] = []
  for (const value of ignore) {
    const item = runtimeString(value)
    if (item === undefined) throw invalidGitHubIgnore()
    parsed.push(item)
  }
  return [
    ...sourceIgnores.defaults,
    ...parsed,
  ]
}

function runtimeString(value: unknown): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]" ? String(value) : undefined
}

function invalidGitHubIgnore(): Error {
  return workspaceError("[vitehub] GitHub Source ignore must be false, a string, or an array of strings.")
}
