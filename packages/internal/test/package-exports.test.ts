import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

type InternalManifest = {
  exports?: Record<string, string>
}

describe("internal package exports", () => {
  it("points every generated JavaScript export at a source module", () => {
    const packageRoot = join(import.meta.dirname, "..")
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as InternalManifest

    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (!target.startsWith("./dist/") || !target.endsWith(".js")) continue

      const source = join(packageRoot, "src", target.slice("./dist/".length, -3) + ".ts")
      expect(existsSync(source), `${subpath} should point at a source module: ${source}`).toBe(true)
      const built = join(packageRoot, target)
      expect(existsSync(built), `${subpath} should point at a built module: ${built}`).toBe(true)
    }
  })
})
