import { existsSync } from "node:fs"

import { describe, expect, it } from "vitest"

import manifest from "../package.json" with { type: "json" }

function distributionTargets(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./dist/") ? [value] : []
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(distributionTargets)
}

describe("internal package exports", () => {
  it("points every distribution export at a generated file", () => {
    const missing = [...new Set(distributionTargets(manifest.exports))]
      .filter(target => !existsSync(new URL(`..${target.slice(1)}`, import.meta.url)))

    expect(missing).toEqual([])
  })
})
