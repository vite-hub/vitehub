import { existsSync, readFileSync } from "node:fs"
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
  exports: Record<string, string | { import: string, types: string }>
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
