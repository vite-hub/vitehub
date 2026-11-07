import { createHash } from "node:crypto"

/** Where a derived file, such as a translation, came from: a Workspace path and the SHA-256 of its bytes then. */
export interface WorkspaceDerivedFrom {
  path: string
  digest: string
}

/** A derived file whose source changed or is gone since it was made. */
export interface WorkspaceStaleFile {
  path: string
  derivedFrom: WorkspaceDerivedFrom
  /** `changed`: the source has other bytes now. `missing`: the source is gone. */
  reason: "changed" | "missing"
  /** The digest of the source now. Write it as `derivedFrom.digest` after you update the file. */
  sourceDigest?: string
}

/** The digest that `derivedFrom.digest` holds: `sha256-` and the hex SHA-256 of the file bytes. */
export function lineageDigest(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`
}

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const flow = /^derivedFrom:[ \t]*\{(.*)\}[ \t]*$/m
const block = /^derivedFrom:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))+)/m

function unquote(value: string): string {
  const trimmed = value.trim()
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

function fields(pairs: Iterable<string>): WorkspaceDerivedFrom | undefined {
  const values = new Map<string, string>()
  for (const pair of pairs) {
    const separator = pair.indexOf(":")
    if (separator > 0) values.set(pair.slice(0, separator).trim(), unquote(pair.slice(separator + 1)))
  }
  const path = values.get("path")
  const digest = values.get("digest")
  return path && digest ? { digest, path } : undefined
}

function fromYaml(source: string): WorkspaceDerivedFrom | undefined {
  const inline = flow.exec(source)
  if (inline) return fields(inline[1]!.split(","))
  const nested = block.exec(source)
  return nested ? fields(nested[1]!.split(/\r?\n/)) : undefined
}

function fromJson(source: string): WorkspaceDerivedFrom | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    return undefined
  }
  const value: unknown = Object(parsed) === parsed ? Reflect.get(Object(parsed), "derivedFrom") : undefined
  if (Object(value) !== value) return undefined
  const path: unknown = Reflect.get(Object(value), "path")
  const digest: unknown = Reflect.get(Object(value), "digest")
  return typeof path === "string" && path && typeof digest === "string" && digest ? { digest, path } : undefined
}

/**
 * Reads `derivedFrom` of a file: the YAML frontmatter of Markdown, a YAML file, or the top-level key of a JSON file.
 * Returns undefined for other files and for files without it.
 */
export function readDerivedFrom(path: string, bytes: Uint8Array): WorkspaceDerivedFrom | undefined {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  }
  catch {
    return undefined
  }
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  if (extension === "json") return fromJson(text)
  if (extension === "yaml" || extension === "yml") return fromYaml(text)
  const head = frontmatter.exec(text)
  return head ? fromYaml(head[1]!) : undefined
}

/** The derived files of a file set whose source changed or is gone, sorted by path. */
export function staleDerivedFiles(files: ReadonlyMap<string, Uint8Array>): WorkspaceStaleFile[] {
  const stale: WorkspaceStaleFile[] = []
  for (const [path, bytes] of files) {
    const derivedFrom = readDerivedFrom(path, bytes)
    if (!derivedFrom) continue
    const source = files.get(derivedFrom.path)
    if (!source) {
      stale.push({ derivedFrom, path, reason: "missing" })
      continue
    }
    const sourceDigest = lineageDigest(source)
    if (sourceDigest !== derivedFrom.digest) stale.push({ derivedFrom, path, reason: "changed", sourceDigest })
  }
  return stale.sort((left, right) => left.path < right.path ? -1 : 1)
}
