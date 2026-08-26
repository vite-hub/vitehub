import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { object, optional, parse, string } from "valibot"
import { describe, expect, it } from "vitest"

import { testLayerIncludes, testLayersFor } from "./layers.ts"
import { rootTestTasks } from "./tasks.ts"

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

  it("keeps named root tasks on their owned configs", () => {
    expect(rootTestTasks["test:contracts"]).toMatchObject({
      command: "vp test --config vitest.config.ts",
      dependsOn: ["build"],
    })
    expect(rootTestTasks["test:consumer"]).toMatchObject({
      command: "vp test --config test/consumer/vitest.config.ts",
      dependsOn: ["build"],
    })
    expect(rootTestTasks["test:output"].command).toBe(
      "vp run test:output:cloudflare && vp run test:output:vercel",
    )
    for (const provider of ["cloudflare", "vercel"]) {
      const task = provider === "cloudflare"
        ? rootTestTasks["test:output:cloudflare"]
        : rootTestTasks["test:output:vercel"]
      const { command } = task
      expect(command).toContain(`vp run playground:vite:build:local --provider ${provider}`)
      expect(command).toContain(`test/output/${provider}.test.ts`)
    }
  })

  it("keeps package tests behind their package build", () => {
    const violations = readdirSync(resolve(repoRoot, "packages"), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap((entry) => {
        const manifestPath = join(repoRoot, "packages", entry.name, "package.json")
        const manifest = parse(packageManifestSchema, JSON.parse(readFileSync(manifestPath, "utf8")))
        if (!manifest.scripts?.test) return []
        return manifest.scripts.build && manifest.scripts.test.includes("#build")
          ? []
          : [manifest.name]
      })

    expect(violations).toEqual([])
  })
})
