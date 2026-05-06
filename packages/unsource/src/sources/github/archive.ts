import { Buffer } from "node:buffer"
import { gunzipSync } from "node:zlib"

import { normalizeSourcePath } from "../../core/path.ts"

import type { GitHubArchiveFile } from "./types.ts"

export function parseGitHubArchive(bytes: Uint8Array) {
  const tar = gunzipSync(bytes)
  const files: GitHubArchiveFile[] = []
  let offset = 0
  let paxPath: string | undefined

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const path = paxPath || [prefix, name].filter(Boolean).join("/")
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8) || 0
    const type = String.fromCharCode(header[156] || 0)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    const content = tar.subarray(contentStart, contentEnd)

    if (type === "x") {
      paxPath = readPaxPath(content)
    }
    else {
      if (type === "0" || type === "\0") {
        const entryPath = stripArchiveRoot(path)
        if (entryPath) {
          files.push({
            content: new Uint8Array(content),
            path: entryPath,
          })
        }
      }
      paxPath = undefined
    }

    offset = contentStart + Math.ceil(size / 512) * 512
  }

  return files
}

function readTarString(buffer: Uint8Array, offset: number, length: number) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf8")
}

function readPaxPath(content: Uint8Array) {
  let index = 0
  while (index < content.length) {
    let space = index
    while (space < content.length && content[space] !== 32) space++
    if (space >= content.length) return

    const length = Number.parseInt(Buffer.from(content.subarray(index, space)).toString("ascii"), 10)
    if (!Number.isFinite(length) || length <= 0 || index + length > content.length) return

    const record = content.subarray(space + 1, index + length - 1)
    const equals = record.indexOf(61)
    if (equals !== -1 && Buffer.from(record.subarray(0, equals)).toString("utf8") === "path") {
      return Buffer.from(record.subarray(equals + 1)).toString("utf8")
    }
    index += length
  }
}

function stripArchiveRoot(path: string) {
  const slash = path.indexOf("/")
  if (slash === -1) return
  return normalizeSourcePath(path.slice(slash + 1))
}
