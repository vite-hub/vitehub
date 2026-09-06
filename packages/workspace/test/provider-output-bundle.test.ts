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
  it("keeps esbuild external in the Vite entry", async () => {
    const output = await readLocalImportClosure(new URL(`../${"dist"}/vite.js`, import.meta.url))

    expect(output).toContain(`from "esbuild"`)
    expect(output).not.toContain("esbuildCommandAndArgs")
  })
})
