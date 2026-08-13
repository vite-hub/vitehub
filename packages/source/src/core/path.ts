import { sourcePathError } from "./errors.ts"

import type { ReadSourceOptions, ReadSourceResult, SourceContent } from "./types.ts"

export function normalizeSourcePath(path = ""): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

interface SafeSourcePathOptions {
  allowEmpty?: boolean
  allowReserved?: boolean
}

export function normalizeSafeSourcePath(path = "", options: SafeSourcePathOptions = {}): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = normalizeSourcePath(path)
  const parts = normalized.split("/").filter(Boolean)

  if (!options.allowEmpty && !normalized) throw sourcePathError(path)
  if (
    raw.startsWith("/")
    || /^[a-z]:\//i.test(raw)
    || parts.some(part => part === "." || part === "..")
  ) throw sourcePathError(path)
  if (!options.allowReserved && (parts[0] === ".git" || parts[0] === ".vitehub")) throw sourcePathError(path)

  return normalized
}

export function decodeSourceContent<TOptions extends ReadSourceOptions | undefined>(
  content: SourceContent,
  options?: TOptions,
): ReadSourceResult<TOptions> {
  if (options?.encoding === "binary") {
    return (typeof content === "string" ? new TextEncoder().encode(content) : content) as ReadSourceResult<TOptions>
  }
  return (typeof content === "string" ? content : new TextDecoder().decode(content)) as ReadSourceResult<TOptions>
}
