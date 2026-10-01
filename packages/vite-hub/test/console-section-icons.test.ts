import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { consoleContributedSectionIcons, consoleContributedSections } from "../src/console/contributions.ts"

// The package `test` script builds first. This directory holds the prebuilt Console that applications serve.
const consoleAssetRoot = resolve(import.meta.dirname, "../dist/console/runtime/public/console")

interface BundledIconCollection {
  aliases?: Record<string, unknown>
  icons: Record<string, unknown>
  prefix: string
}

/** Reads the Iconify collections that Nuxt UI inlines as `JSON.parse(`[...]`)` in the Console entry. */
function readBundledIcons(): Set<string> {
  const entry = readdirSync(consoleAssetRoot).find(file => /^console-.+\.js$/.test(file))
  if (!entry) throw new Error(`Console entry is missing in ${consoleAssetRoot}. Build vite-hub first.`)
  const code = readFileSync(join(consoleAssetRoot, entry), "utf8")
  const icons = new Set<string>()
  for (const match of code.matchAll(/JSON\.parse\(`(\[\{"prefix":[\s\S]*?\}\])`\)/g)) {
    const collections: BundledIconCollection[] = JSON.parse(match[1]!.replace(/\\([\\`$])/g, "$1"))
    for (const collection of collections) {
      for (const name of [...Object.keys(collection.icons), ...Object.keys(collection.aliases ?? {})]) {
        icons.add(`i-${collection.prefix}-${name}`)
      }
    }
  }
  return icons
}

describe("Console section icons", () => {
  it("lists the icon of every contributed section", () => {
    for (const section of consoleContributedSections.values()) {
      expect(consoleContributedSectionIcons).toContain(section.descriptor.icon)
    }
  })

  it("bundles every contributed section icon in the prebuilt Console", () => {
    const bundled = readBundledIcons()
    expect(bundled.has("i-lucide-moon")).toBe(true)
    const missing = [...consoleContributedSections.values()]
      .map(section => section.descriptor.icon)
      .filter(icon => !bundled.has(icon))
    expect(missing).toEqual([])
  })
})
