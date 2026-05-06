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
  const text = Buffer.from(content).toString("utf8")
  let index = 0
  while (index < text.length) {
    const space = text.indexOf(" ", index)
    if (space === -1) return
    const length = Number.parseInt(text.slice(index, space), 10)
    if (!length) return
    const record = text.slice(space + 1, index + length - 1)
    const equals = record.indexOf("=")
    if (equals !== -1 && record.slice(0, equals) === "path") return record.slice(equals + 1)
    index += length
  }
}

function stripArchiveRoot(path: string) {
  const slash = path.indexOf("/")
  if (slash === -1) return
  return normalizeSourcePath(path.slice(slash + 1))
}
