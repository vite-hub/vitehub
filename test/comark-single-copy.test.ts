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
  it.each(["content", "cms", "docs"])("@vite-hub/%s takes comark, @comark/html, and comark-ui from the app", async (directory) => {
    const { dependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = await manifest(directory)
    for (const name of ["comark", "@comark/html", "comark-ui"]) {
      expect(dependencies, name).not.toHaveProperty(name)
      expect(peerDependencies, name).toHaveProperty(name)
      expect(peerDependenciesMeta[name]?.optional, name).not.toBe(true)
    }
  })
})
