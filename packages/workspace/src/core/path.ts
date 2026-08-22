import { relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { minimatch } from "minimatch"

import { workspacePathError } from "./errors.ts"

import type { ReadFileOptions, ReadFileResult, WorkspaceContent, WorkspaceContentStream } from "./types.ts"

export function normalizeWorkspacePath(path = ""): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

export function isExcludedWorkspacePath(path: string, excluded: readonly string[] = []): boolean {
  const normalized = normalizeWorkspacePath(path)
  return excluded.some((item) => {
    const excludedPath = normalizeWorkspacePath(item)
    return normalized === excludedPath || normalized.startsWith(`${excludedPath}/`)
  })
}

export interface SafeWorkspacePathOptions {
  allowEmpty?: boolean
  allowReserved?: boolean
  pattern?: boolean
}

export function normalizeSafeWorkspacePath(path = "", options: SafeWorkspacePathOptions = {}): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = normalizeWorkspacePath(path)
  const parts = normalized.split("/").filter(Boolean)

  if (!options.allowEmpty && !normalized) throw workspacePathError(path)
  if (raw.startsWith("/") || parts.some(part => part === "." || part === "..")) throw workspacePathError(path)
  if (!options.allowReserved && (parts.some(part => part.toLowerCase() === ".git") || parts[0] === ".vitehub")) throw workspacePathError(path)

  return normalized
}

export function normalizeSafeWorkspacePattern(pattern: string): string {
  return normalizeSafeWorkspacePath(pattern, { allowEmpty: true, pattern: true })
}

export function resolveInside(root: string, path = ""): string {
  const resolvedRoot = resolve(root)
  const resolved = resolve(resolvedRoot, normalizeWorkspacePath(path))
  const rel = relative(resolvedRoot, resolved)

  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || rel === "") {
    if (rel === "") return resolved
    throw workspacePathError(path)
  }

  return resolved
}

export function matchesAny(path: string, patterns?: string | string[]): boolean {
  if (!patterns) return true
  const list = Array.isArray(patterns) ? patterns : [patterns]
  const normalizedPath = normalizeWorkspacePath(path)
  return list.some(pattern => minimatch(normalizedPath, normalizeWorkspacePath(pattern), { dot: true }))
}

export function contentToBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof (value as { getReader?: unknown }).getReader === "function")
}

export async function* contentStreamChunks(stream: WorkspaceContentStream): AsyncGenerator<Uint8Array> {
  if (isReadableStream(stream)) {
    const reader = stream.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return
        yield chunk.value
      }
    }
    finally {
      reader.releaseLock()
    }
    return
  }

  yield* stream
}

export async function contentStreamToBytes(stream: WorkspaceContentStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of contentStreamChunks(stream)) {
    chunks.push(chunk)
    size += chunk.byteLength
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
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
