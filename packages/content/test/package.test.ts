import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

const dist = new URL("../dist/", import.meta.url)

/** Bare specifiers that a built entry loads at startup, following its own static imports. */
async function startupImports(entry: string): Promise<Set<string>> {
  const bare = new Set<string>()
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const code = await readFile(new URL(file, dist), "utf8")
    for (const match of code.matchAll(/^(?:import|export)\b[^"']*?from\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? match[2] ?? ""
      if (specifier.startsWith(".")) pending.push(new URL(specifier, new URL(file, dist)).href.slice(dist.href.length))
      else bare.add(specifier)
    }
  }
  return bare
}

describe("@vite-hub/content package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/content", [
      ".",
      "./client",
      "./collections",
      "./database",
    ])
  })

  it("loads Workspace and Database only from the collections entry", async () => {
    const workspaceOrDatabase = (imports: Set<string>) => [...imports].filter(specifier => /^@vite-hub\/(?:workspace|database)(?:\/|$)/.test(specifier))

    expect(workspaceOrDatabase(await startupImports("index.js"))).toEqual([])
    expect(workspaceOrDatabase(await startupImports("vite.js"))).toEqual([])
    expect(workspaceOrDatabase(await startupImports("collections.js"))).toContain("@vite-hub/workspace")
  })
})
