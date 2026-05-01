import { relative, resolve, sep } from "node:path"
import { createHash } from "node:crypto"

import { WorkspacePathError } from "./errors.ts"

export function normalizeWorkspacePath(path = ""): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
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

function escapeRegex(input: string) {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeWorkspacePath(pattern)
  let source = ""
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]
    const next = normalized[index + 1]
    const afterNext = normalized[index + 2]
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?"
      index += 2
    }
    else if (char === "*" && next === "*") {
      source += ".*"
      index++
    }
    else if (char === "*") {
      source += "[^/]*"
    }
    else if (char === "?") {
      source += "[^/]"
    }
    else {
      source += escapeRegex(char || "")
    }
  }
  return new RegExp(`^${source}$`)
}

export function matchesAny(path: string, patterns?: string | string[]): boolean {
  if (!patterns) return true
  const list = Array.isArray(patterns) ? patterns : [patterns]
  return list.some(pattern => globToRegExp(pattern).test(normalizeWorkspacePath(path)))
}

export function contentToBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content
}

export async function sha256(input: unknown): Promise<string> {
  const bytes = contentToBytes(typeof input === "string" || input instanceof Uint8Array ? input : JSON.stringify(input))
  return createHash("sha256").update(bytes).digest("hex")
}
