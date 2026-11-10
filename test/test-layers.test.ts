import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { object, optional, parse, string } from "valibot"
import { describe, expect, it } from "vitest"

import { testLayerIncludes, testLayersFor } from "./layers.ts"

const repoRoot = resolve(import.meta.dirname, "..")
const packageManifestSchema = object({
  name: string(),
  scripts: optional(object({
    build: optional(string()),
    test: optional(string()),
  })),
})

function trackedTestFiles() {
  return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(path => /^(?:packages|test)\//.test(path) && /\.test(?:-d)?\.ts$/.test(path))
}

describe("root test layers", () => {
  it("assigns every tracked root and package test to one layer", () => {
    const assignments = trackedTestFiles().map(path => ({ layers: testLayersFor(path), path }))

    expect(assignments.filter(({ layers }) => layers.length !== 1)).toEqual([])
    for (const layer of Object.keys(testLayerIncludes)) {
      expect(assignments.some(assignment => assignment.layers.includes(layer)), layer).toBe(true)
    }
  })

  it("keeps package tests behind their package build", () => {
    const packageDirsWithTests = new Set(
      trackedTestFiles()
        .filter(path => path.startsWith("packages/"))
        .map(path => path.split("/").slice(0, 2).join("/")),
    )
    const violations = readdirSync(resolve(repoRoot, "packages"), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && packageDirsWithTests.has(`packages/${entry.name}`))
      .flatMap((entry) => {
        const manifestPath = join(repoRoot, "packages", entry.name, "package.json")
        const manifest = parse(packageManifestSchema, JSON.parse(readFileSync(manifestPath, "utf8")))
        return manifest.scripts?.build
          && manifest.scripts.test?.includes(`${manifest.name}#build`)
          ? []
          : [manifest.name]
      })

    expect(violations).toEqual([])
  })
})
