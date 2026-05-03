import { relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { minimatch } from "minimatch"

import { WorkspacePathError } from "./errors.ts"

import type { GlobOptions, ReadFileOptions, ReadFileResult, WorkspaceContent } from "./types.ts"

export function normalizeWorkspacePath(path = ""): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

export interface SafeWorkspacePathOptions {
  allowEmpty?: boolean
  allowReserved?: boolean
}

export function normalizeSafeWorkspacePath(path = "", options: SafeWorkspacePathOptions = {}): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = normalizeWorkspacePath(path)
  const parts = normalized.split("/").filter(Boolean)

  if (!options.allowEmpty && !normalized) throw new WorkspacePathError(path)
  if (raw.startsWith("/") || parts.some(part => part === "." || part === "..")) throw new WorkspacePathError(path)
  if (!options.allowReserved && (parts[0] === ".git" || parts[0] === ".vitehub")) throw new WorkspacePathError(path)

  return normalized
}

export function normalizeSafeWorkspacePattern(pattern: string): string {
  return normalizeSafeWorkspacePath(pattern, { allowEmpty: true })
}

export function resolveInside(root: string, path = ""): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, normalizeWorkspacePath(path))
  const rel = relative(resolvedRoot, resolved)

  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || rel === "") {
    if (rel === "") return resolved
    throw new WorkspacePathError(path)
  }

  return resolved
}

export function matchesAny(path: string, patterns?: string | string[]): boolean {
  if (!patterns) return true
  const list = Array.isArray(patterns) ? patterns : [patterns]
  const normalizedPath = normalizeWorkspacePath(path)
  return list.some(pattern => minimatch(normalizedPath, normalizeWorkspacePath(pattern), { dot: true }))
}

export function resolveGlobPatterns(pattern: string | string[], options: GlobOptions = {}): string[] {
  const cwd = normalizeSafeWorkspacePath(options.cwd || "", { allowEmpty: true })
  return (Array.isArray(pattern) ? pattern : [pattern])
    .map(normalizeSafeWorkspacePattern)
    .map(item => cwd ? `${cwd}/${item}` : item)
}

export function contentToBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content
}

export function decodeFile<TOptions extends ReadFileOptions | undefined>(
  content: WorkspaceContent,
  options?: TOptions,
): ReadFileResult<TOptions> {
  if (options?.encoding === "binary") return content as ReadFileResult<TOptions>
  return (typeof content === "string" ? content : new TextDecoder().decode(content)) as ReadFileResult<TOptions>
}

export async function sha256(input: unknown): Promise<string> {
  const bytes = contentToBytes(typeof input === "string" || input instanceof Uint8Array ? input : JSON.stringify(input))
  return createHash("sha256").update(bytes).digest("hex")
}
