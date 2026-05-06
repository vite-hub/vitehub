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
}

export function createTarGz(files: Record<string, string>) {
  const blocks: Buffer[] = []
  for (const [path, value] of Object.entries(files)) {
    const content = Buffer.from(value)
    const header = Buffer.alloc(512)
    header.write(`archive-main/${path}`, 0, 100)
    header.write("0000644\0", 100, 8)
    header.write("0000000\0", 108, 8)
    header.write("0000000\0", 116, 8)
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12)
    header.write("00000000000\0", 136, 12)
    header.fill(" ", 148, 156)
    header.write("0", 156, 1)
    header.write("ustar\0", 257, 6)
    header.write("00", 263, 2)
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8)
    blocks.push(header, content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

export function stubGitHubSource(files: Record<string, string>, options: StubGitHubSourceOptions | number = 200) {
  const apiStatus = typeof options === "number" ? options : options.apiStatus ?? 200
  const archiveStatus = typeof options === "number" ? options : options.archiveStatus ?? 200

  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const requestUrl = String(url)

    if (requestUrl.startsWith("https://codeload.github.com/")) {
      if (archiveStatus !== 200) return new Response("not found", { status: archiveStatus })
      return new Response(createTarGz(files))
    }

    if (apiStatus !== 200) {
      return jsonResponse({ message: "not found" }, apiStatus)
    }

    if (requestUrl.includes("/git/trees/")) {
      return jsonResponse({
        sha: "tree-sha",
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
