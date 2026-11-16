import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { distributionEntriesFromManifest } from "../vite.config.ts"

const packageRoot = new URL("../", import.meta.url)
const manifest: { dependencies: Record<string, string>, exports: Record<string, unknown>, peerDependencies: Record<string, string> }
  = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"))
const ownerPackages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter(name => name.startsWith("@vite-hub/")))

/**
 * Every public `vite-hub/<owner>/<path>` subpath whose first segment names an owner package.
 */
const facades = Object.entries(manifest.exports).flatMap(([subpath, target]) => {
  const path = subpath.replace(/^\.\/?/, "")
  if (!path || path.startsWith("_internal/") || !ownerPackages.has(`@vite-hub/${path.split("/")[0]}`)) return []
  return distributionEntriesFromManifest(target).map(source => ({ owner: `@vite-hub/${path}`, source, subpath: `vite-hub/${path}` }))
})

/** The lines that a facade may contain: it re-exports its owner, and the owner's default export when it has one. */
function facadeProblems(source: string, owner: string): string[] {
  const allowed = new Set([`export * from "${owner}"`, `export { default } from "${owner}"`])
  const lines = source.split("\n").map(line => line.trim()).filter(Boolean)
  const problems = lines.filter(line => !allowed.has(line))
  if (!lines.includes(`export * from "${owner}"`)) problems.push(`missing: export * from "${owner}"`)
  return problems
}

describe("pure vite-hub facades", () => {
  it("finds the facades of the owner packages", () => {
    expect(facades.map(({ subpath }) => subpath)).toEqual(expect.arrayContaining([
      "vite-hub/agent",
      "vite-hub/agent/capabilities",
      "vite-hub/content",
      "vite-hub/content/collections",
      "vite-hub/kv",
      "vite-hub/source",
      "vite-hub/source/drizzle",
    ]))
  })

  // An import path never changes behavior: `vite-hub/x` and `@vite-hub/x` must give the same values.
  for (const { owner, source, subpath } of facades) {
    it(`${subpath} only re-exports ${owner}`, () => {
      expect(facadeProblems(readFileSync(new URL(source, packageRoot), "utf8"), owner)).toEqual([])
    })
  }

  it("rejects a facade with its own code", () => {
    expect(facadeProblems(`export * from "@vite-hub/agent"\nexport const defineAgent = () => {}\n`, "@vite-hub/agent"))
      .toEqual(["export const defineAgent = () => {}"])
    expect(facadeProblems(`export * from "@vite-hub/content"\nexport * from "@vite-hub/content/collections"\n`, "@vite-hub/content"))
      .toEqual([`export * from "@vite-hub/content/collections"`])
    expect(facadeProblems(`export { kv } from "@vite-hub/kv"\n`, "@vite-hub/kv"))
      .toEqual([`export { kv } from "@vite-hub/kv"`, `missing: export * from "@vite-hub/kv"`])
  })

  it("gives the owner values unchanged", async () => {
    const pairs: Array<[string, () => Promise<object>, () => Promise<object>]> = [
      ["vite-hub/agent", () => import("../src/agent.ts"), () => import("@vite-hub/agent")],
      ["vite-hub/agent/capabilities", () => import("../src/agent/capabilities.ts"), () => import("@vite-hub/agent/capabilities")],
      ["vite-hub/runtime", () => import("../src/runtime.ts"), () => import("@vite-hub/runtime")],
      ["vite-hub/source", () => import("../src/source.ts"), () => import("@vite-hub/source")],
      ["vite-hub/source/drizzle", () => import("../src/source/drizzle.ts"), () => import("@vite-hub/source/drizzle")],
      ["vite-hub/source/server", () => import("../src/source/server.ts"), () => import("@vite-hub/source/server")],
    ]
    for (const [name, facade, owner] of pairs) {
      const facadeModule: Record<string, unknown> = { ...await facade() }
      const ownerModule: Record<string, unknown> = { ...await owner() }
      expect(Object.keys(facadeModule).sort(), name).toEqual(Object.keys(ownerModule).sort())
      for (const [key, value] of Object.entries(ownerModule)) expect(facadeModule[key], `${name} ${key}`).toBe(value)
    }
  })
})
