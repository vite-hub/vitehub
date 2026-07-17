import { existsSync, globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import * as ownerAgent from "@vite-hub/agent"
import * as ownerCapabilities from "@vite-hub/agent/capabilities"
import ownerAuthHandler from "@vite-hub/auth/server"
import * as framework from "vite-hub"
import * as frameworkAgent from "vite-hub/agent"
import * as frameworkCapabilities from "vite-hub/agent/capabilities"
import frameworkAuthHandler from "vite-hub/auth/server"
import { distributionBinEntries, distributionEntriesFromManifest } from "../vite.config.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  bin: Record<string, string>
  dependencies: Record<string, string>
  exports: Record<string, string | { import: string, types: string }>
}

const forwarderExportLine = /^export (?:type )?(?:\*|\{[^}]+\}) from "([^"]+)"$/

function sourceForwarderTargets(source: string): string[] | undefined {
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) return

  const targets: string[] = []
  for (const line of lines) {
    const target = line.match(forwarderExportLine)?.[1]
    if (!target) return
    targets.push(target)
  }
  return targets
}

function ownerSpecifierForDistributionSubpath(subpath: string): string {
  const [owner, ...rest] = subpath.replace(/^\.\/(?:_internal\/)?/, "").split("/")
  return [`@vite-hub/${owner}`, ...rest].join("/")
}

describe("framework package contract", () => {
  it("keeps the root export intentionally small", () => {
    expect(Object.keys(framework)).toEqual(["vitehub"])
  })

  it("forwards feature APIs from their owner packages", () => {
    expect(frameworkAgent.defineAgent).toBe(ownerAgent.defineAgent)
    expect(frameworkCapabilities.email).toBe(ownerCapabilities.email)
    expect(frameworkCapabilities.workspaceShell).toBe(ownerCapabilities.workspaceShell)
    expect(frameworkAuthHandler).toBe(ownerAuthHandler)
  })

  it("keeps every source forwarder owned by its matching package export", () => {
    const manifestEntries = Object.entries(manifest.exports).flatMap(([subpath, target]) =>
      distributionEntriesFromManifest(target).map(source => ({ source, subpath })),
    )
    const manifestForwarders = manifestEntries.flatMap(({ source, subpath }) => {
      const targets = sourceForwarderTargets(readFileSync(`${packageRoot}/${source}`, "utf8"))
      return targets ? [{ source, subpath, targets }] : []
    })
    const sourceForwarders = globSync("src/**/*.ts", { cwd: packageRoot })
      .filter(source => !source.endsWith(".d.ts"))
      .filter(source => sourceForwarderTargets(readFileSync(`${packageRoot}/${source}`, "utf8")))
      .sort()
    const exportedForwarders = new Set(manifestForwarders.map(({ source }) => source))

    expect(sourceForwarders).toEqual([...exportedForwarders].sort())
    expect(manifestEntries
      .filter(({ source }) => !exportedForwarders.has(source))
      .map(({ subpath }) => subpath)
      .sort(),
    ).toEqual([".", "./_internal/kv/runtime/disabled-upstash"])

    for (const { subpath, targets } of manifestForwarders) {
      const ownerSpecifier = ownerSpecifierForDistributionSubpath(subpath)
      const ownerPackage = ownerSpecifier.split("/").slice(0, 2).join("/")
      expect([...new Set(targets)], subpath).toEqual([ownerSpecifier])
      expect(manifest.dependencies[ownerPackage], subpath).toBeDefined()
    }
  })

  it("ships every declared export and both CLI names", () => {
    expect(manifest.exports).not.toHaveProperty("./bin")
    expect(manifest.bin).toEqual({
      "vite-hub": "./dist/bin.js",
      vitehub: "./dist/bin.js",
    })

    for (const value of Object.values(manifest.exports)) {
      const target = typeof value === "string" ? value : value.import
      if (target === "./package.json") continue
      expect(existsSync(`${packageRoot}/${target}`), target).toBe(true)
    }

    expect(readFileSync(`${packageRoot}/${manifest.bin.vitehub}`, "utf8")).toMatch(/^#!\/usr\/bin\/env node/)
  })

  it("derives deduplicated binary entries from the package manifest", () => {
    expect(distributionBinEntries).toEqual({
      "vite-hub": "src/bin.ts",
      vitehub: "src/bin.ts",
    })
    expect(distributionEntriesFromManifest(manifest.bin)).toEqual(["src/bin.ts"])
  })

  it("normalizes conditional export leaves into unique runtime entries", () => {
    expect(distributionEntriesFromManifest({
      ".": {
        import: {
          default: "./dist/index.js",
          node: "./dist/index.js",
        },
        types: "./dist/index.d.ts",
      },
      "./feature": [
        { types: "./dist/feature.d.ts" },
        { import: "./dist/feature.js" },
      ],
      "./package.json": "./package.json",
    })).toEqual([
      "src/feature.ts",
      "src/index.ts",
    ])
  })
})
