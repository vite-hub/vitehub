import { Buffer } from "node:buffer"
import { gzipSync } from "node:zlib"

import { vi } from "vitest"

export function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  })
}

export interface StubGitHubSourceOptions {
  apiStatus?: number
  archiveStatus?: number
  treeTruncated?: boolean
}

export function createTarGz(files: Record<string, string>) {
  const blocks: Buffer[] = []
  for (const [path, value] of Object.entries(files)) {
    const content = Buffer.from(value)
    const archivePath = `archive-main/${path}`
    const headerPath = needsPaxPath(archivePath) ? writePaxPath(blocks, archivePath) : archivePath
    writeTarEntry(blocks, headerPath, "0", content)
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeTarEntry(blocks: Buffer[], path: string, type: string, content: Buffer) {
  const header = Buffer.alloc(512)
  header.write(path, 0, 100)
  header.write("0000644\0", 100, 8)
  header.write("0000000\0", 108, 8)
  header.write("0000000\0", 116, 8)
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12)
  header.write("00000000000\0", 136, 12)
  header.fill(" ", 148, 156)
  header.write(type, 156, 1)
  header.write("ustar\0", 257, 6)
  header.write("00", 263, 2)
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8)
  blocks.push(header, content)
  const padding = (512 - (content.length % 512)) % 512
  if (padding) blocks.push(Buffer.alloc(padding))
}

function writePaxPath(blocks: Buffer[], path: string) {
  writeTarEntry(blocks, "archive-main/PaxHeader", "x", createPaxRecord("path", path))
  return "archive-main/pax-file"
}

function createPaxRecord(key: string, value: string) {
  const payload = `${key}=${value}\n`
  let length = Buffer.byteLength(payload) + 3
  while (true) {
    const record = `${length} ${payload}`
    const size = Buffer.byteLength(record)
    if (size === length) return Buffer.from(record)
    length = size
  }
}

function needsPaxPath(path: string) {
  return Buffer.byteLength(path) > 100 || [...path].some(char => char.charCodeAt(0) > 0x7F)
}

export function stubGitHubSource(files: Record<string, string>, options: StubGitHubSourceOptions | number = 200) {
  const apiStatus = typeof options === "number" ? options : options.apiStatus ?? 200
  const archiveStatus = typeof options === "number" ? options : options.archiveStatus ?? 200
  const treeTruncated = typeof options === "number" ? false : options.treeTruncated ?? false

  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const requestUrl = String(url)

    if (requestUrl.startsWith("https://codeload.github.com/")) {
      if (archiveStatus !== 200) return new Response("not found", { status: archiveStatus })
      return new Response(createTarGz(files))
    }

    if (apiStatus !== 200) {
      return jsonResponse({ message: "not found" }, apiStatus)
    }

    if (requestUrl === "https://api.github.com/repos/acme/app" || requestUrl === "https://api.github.com/repos/acme/private") {
      return jsonResponse({ default_branch: "main" })
    }

    if (requestUrl.endsWith("/commits/main")) {
      return jsonResponse({ sha: "latest-commit-sha" })
    }

    if (requestUrl.includes("/git/trees/")) {
      return jsonResponse({
        sha: "tree-sha",
        truncated: treeTruncated,
        tree: [
          ...Object.keys(files).map(path => ({ path, sha: `sha-${path}`, type: "blob" })),
          { path: "docs/guide", type: "tree" },
        ],
      })
    }

    if (requestUrl.startsWith("https://raw.githubusercontent.com/")) {
      const url = new URL(requestUrl)
      const path = decodeURIComponent(url.pathname.split("/").slice(4).join("/"))
      const content = files[path]
      if (content === undefined) return new Response("not found", { status: 404 })
      return new Response(content)
    }

    const path = decodeURIComponent(requestUrl.match(/contents\/(?<path>.+)\?ref/)?.groups?.path ?? "")
    return jsonResponse({
      content: Buffer.from(files[path] || "").toString("base64"),
      encoding: "base64",
    })
  }))
}
