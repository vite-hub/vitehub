import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const packagesRoot = resolve(import.meta.dirname, "../packages")

async function builtPackages(): Promise<string[]> {
  const names = await readdir(packagesRoot)
  return names.filter(name => existsSync(join(packagesRoot, name, "dist"))).sort()
}

async function codeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile() && /\.m?js$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name))
}

async function inlinesJsonSchema(name: string): Promise<boolean> {
  for (const file of await codeFiles(join(packagesRoot, name, "dist"))) {
    if (/^\/\/(?:#region)? [^\n]*@valibot\+to-json-schema/m.test(await readFile(file, "utf8"))) return true
  }
  return false
}

describe("@valibot/to-json-schema", () => {
  it("is not inlined in a package dist, so an app bundles one copy", async () => {
    const packages = await builtPackages()
    expect(packages).toContain("internal")
    const inlined = []
    for (const name of packages) {
      if (await inlinesJsonSchema(name)) inlined.push(name)
    }
    expect(inlined).toEqual([])
  })
})
