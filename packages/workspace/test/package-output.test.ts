import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

async function listJavaScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return await listJavaScriptFiles(path)
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : []
  }))
  return files.flat()
}

describe("package output", () => {
  it("does not externalize @vitehub/unshell", async () => {
    const files = await listJavaScriptFiles(fileURLToPath(new URL("../dist", import.meta.url)))
    const references = await Promise.all(files.map(async (file) => ({
      file,
      source: await readFile(file, "utf8"),
    })))

    expect(references.filter(({ source }) => source.includes("@vitehub/unshell"))).toEqual([])
  })
})
