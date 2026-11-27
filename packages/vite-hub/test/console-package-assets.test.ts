import { existsSync, globSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

describe("Console package assets", () => {
  it("ships the relative imports used by copied Vue components and TypeScript helpers", () => {
    const runtime = fileURLToPath(new URL("../dist/console/runtime", import.meta.url))
    const files = globSync("**/*.{vue,ts}", { cwd: runtime })
      .filter(file => !file.endsWith(".d.ts"))
    expect(files.length).toBeGreaterThan(0)
    const missing: string[] = []
    for (const file of files) {
      const path = resolve(runtime, file)
      const source = readFileSync(path, "utf8")
      const imports = source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)
      for (const [, specifier] of imports) {
        const target = resolve(dirname(path), specifier!)
        if (!["", ".ts", ".js", ".vue", ".json"].some(extension => existsSync(`${target}${extension}`))) {
          missing.push(`${file} imports ${specifier}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
