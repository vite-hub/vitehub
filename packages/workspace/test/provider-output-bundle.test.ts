import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

async function readLocalImportClosure(entry: URL, visited = new Set<string>()): Promise<string> {
  if (visited.has(entry.href)) return ""
  visited.add(entry.href)
  const source = await readFile(entry, "utf8")
  const localImports = [...source.matchAll(/\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'](\.[^"']+)["']/g)]
    .map(match => match[1]!)

  return [source, ...await Promise.all(localImports.map(specifier => readLocalImportClosure(new URL(specifier, entry), visited)))].join("\n")
}

describe("Workspace Provider Output bundle", () => {
  it("loads Vite's Rolldown without bundling esbuild or Rolldown", async () => {
    const output = await readLocalImportClosure(new URL(`../${"dist"}/vite.js`, import.meta.url))

    expect(output).toContain(`.resolve("rolldown")`)
    expect(output).toContain(`.resolve("vite/rolldown")`)
    expect(output).not.toContain(`import("esbuild")`)
    expect(output).not.toContain("esbuildCommandAndArgs")
    expect(output).not.toContain("@rolldown/binding-")
  })
})
