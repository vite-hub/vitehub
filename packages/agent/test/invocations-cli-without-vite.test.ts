import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { expect, it } from "vitest"

const agentDir = resolve(import.meta.dirname, "..")

/** The bare specifiers that a built module imports statically, through its relative chunks and the ViteHub packages it loads. */
async function staticPackageImports(entry: string): Promise<Set<string>> {
  const packages = new Set<string>()
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(file, "utf8")
    // Rolldown prints each static import and re-export on one line. `import()` calls do not match.
    for (const [, from, bare] of source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"|^import\s*"([^"]+)"/gm)) {
      const specifier = from ?? bare!
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier))
      else if (specifier.startsWith("@vite-hub/")) pending.push(createRequire(file).resolve(specifier))
      else if (!specifier.startsWith("node:")) packages.add(specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"))
    }
  }
  return packages
}

// `vite` is an optional peer. A server that installed only production dependencies has no `vite`, and
// `vitehub agent invocations` must still read and prune the journal there.
// `vitehub agent state migrate` runs on the server that holds the State database, for the same reason.
it.each(["agent-invocations-cli", "agent-state-cli"])("loads the %s entry without the optional vite peer", async (entry) => {
  const imports = await staticPackageImports(resolve(agentDir, `dist/internal/${entry}.js`))
  expect(imports.size).toBeGreaterThan(0)
  expect([...imports]).not.toContain("vite")
})
