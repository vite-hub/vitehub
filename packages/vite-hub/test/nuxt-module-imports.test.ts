import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { expect, it } from "vitest"

const packageRoot = resolve(import.meta.dirname, "..")

/** The packages that Node loads with `file`, following its static imports of package chunks. */
async function staticPackageImports(file: string, seen = new Set<string>()): Promise<Set<string>> {
  const packages = new Set<string>()
  if (seen.has(file)) return packages
  seen.add(file)
  const source = await readFile(file, "utf8")
  for (const [, specifier] of source.matchAll(/^(?:import|export)\b[^;"']*?["']([^"']+)["']/gm)) {
    if (specifier!.startsWith(".")) {
      for (const name of await staticPackageImports(resolve(dirname(file), specifier!), seen)) packages.add(name)
    }
    else packages.add(specifier!)
  }
  return packages
}

it("loads the Nuxt module without the Console request runtime", async () => {
  const packages = await staticPackageImports(resolve(packageRoot, "dist/nuxt.js"))
  expect(packages).toContain("vite")
  expect([...packages].filter(name => name === "h3" || name.startsWith("@vite-hub/runtime/h3"))).toEqual([])
})
