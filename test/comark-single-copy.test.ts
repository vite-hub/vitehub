import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")

type Manifest = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

async function manifest(directory: string): Promise<Manifest> {
  return JSON.parse(await readFile(resolve(repoRoot, "packages", directory, "package.json"), "utf8"))
}

describe("Comark in Content", () => {
  // Content renders with the app's Comark UI plugins. A Comark copy of its own, such as 0.9.2 next to the app's 0.9.0,
  // made apps add pnpm overrides to keep one copy. A Comark UI copy of its own gave finance a second comark-ui.
  it.each(["content", "cms", "docs"])("@vite-hub/%s takes comark, @comark/html, and comark-ui from the app", async (directory) => {
    const { dependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = await manifest(directory)
    for (const name of ["comark", "@comark/html", "comark-ui"]) {
      expect(dependencies, name).not.toHaveProperty(name)
      expect(peerDependencies, name).toHaveProperty(name)
      expect(peerDependenciesMeta[name]?.optional, name).not.toBe(true)
    }
  })
})
