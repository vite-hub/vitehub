import { isAbsolute, relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { minimatch } from "minimatch"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { workspacePathError } from "./errors.ts"
import { normalizeSafeWorkspacePath } from "../internal/path.ts"

export { normalizeSafeWorkspacePath }
export type { SafeWorkspacePathOptions } from "../internal/path.ts"

import type { ReadFileOptions, ReadFileResult, WorkspaceContent, WorkspaceContentStream } from "./types.ts"

export function normalizeWorkspacePath(path = ""): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

export function isExcludedWorkspacePath(path: string, excluded: readonly string[] = []): boolean {
  const normalized = normalizeWorkspacePath(path)
  return excluded.some((item) => {
    const excludedPath = normalizeWorkspacePath(item)
    return excludedPath === ""
      || normalized === excludedPath
      || normalized.startsWith(`${excludedPath}/`)
  })
}

export function normalizeSafeWorkspacePattern(pattern: string): string {
  return normalizeSafeWorkspacePath(pattern, { allowEmpty: true, pattern: true })
}

export function resolveInside(root: string, path = ""): string {
  const resolvedRoot = resolve(root)
  const normalized = normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })
  const resolved = resolve(resolvedRoot, normalized)
  const rel = relative(resolvedRoot, resolved)

  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
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

// The intrinsic getter reads the typed array kind without trusting Symbol.toStringTag.
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get

/** Recognize byte arrays from VM and sandbox realms. */
export function isWorkspaceBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && typedArrayTag?.call(value) === "Uint8Array"
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
    let completed = false
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) {
          completed = true
          return
        }
        yield chunk.value
      }
    }
    finally {
      try {
        if (!completed) await reader.cancel()
      }
      finally {
        reader.releaseLock()
      }
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
  const bytes = contentToBytes(hasRuntimeType(input, "string") || isWorkspaceBytes(input) ? input : JSON.stringify(input))
  return createHash("sha256").update(bytes).digest("hex")
}
