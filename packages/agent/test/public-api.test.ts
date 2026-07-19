import { readFile, readdir } from "node:fs/promises"

import { expect, it } from "vitest"

const effectImportPattern = /(?:from\s*|import\()\s*["']effect(?:\/[^"']+)?["']/

async function readBundleGraph(entry: URL): Promise<string> {
  const sources: string[] = []
  const visited = new Set<string>()

  async function visit(file: URL): Promise<void> {
    if (visited.has(file.href)) return
    visited.add(file.href)
    const source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (source === undefined) return
    sources.push(source)
    for (const match of source.matchAll(/(?:from\s*|import\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1]
      if (specifier?.startsWith(".")) await visit(new URL(specifier, file))
    }
  }

  await visit(entry)
  return sources.join("\n")
}

it("keeps Effect out of published Agent declarations", async () => {
  const dist = new URL("../dist/", import.meta.url)
  const declarations = await Promise.all(
    (await readdir(dist, { recursive: true }))
      .filter(path => path.endsWith(".d.ts"))
      .map(path => readFile(new URL(path, dist), "utf8")),
  )

  expect(declarations.join("\n")).not.toMatch(effectImportPattern)
})

it("keeps Effect out of provider and browser bundle graphs", async () => {
  for (const entry of ["cloudflare.js", "cloudflare/state.js", "messages.js", "output.js"]) {
    const bundle = await readBundleGraph(new URL(`../dist/${entry}`, import.meta.url))
    expect(bundle, `${entry} must remain Effect-free`).not.toMatch(effectImportPattern)
  }
})
