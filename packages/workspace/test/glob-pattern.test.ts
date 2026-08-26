import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { assertModelWorkspaceGlobPattern } from "../src/core/glob-pattern.ts"

describe("model-facing Workspace glob patterns", () => {
  it("accepts ordinary braces, alternatives, and padded sequences", () => {
    expect(() => assertModelWorkspaceGlobPattern([
      "docs/*.{md,mdx}",
      "customers/{acme,globex}/**",
      "reports/{001..100}.json",
    ])).not.toThrow()
  })

  it("rejects repeated brace groups and wide alternatives with exact errors", () => {
    expect(() => assertModelWorkspaceGlobPattern("{a,b}".repeat(11))).toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    expect(() => assertModelWorkspaceGlobPattern(`{${",".repeat(1_024)}}`)).toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
    expect(() => assertModelWorkspaceGlobPattern("{a},b}".repeat(11))).toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
  })

  it("rejects expansive padded sequences before matching", () => {
    expect(() => assertModelWorkspaceGlobPattern("reports/{000001..999999}.json")).toThrow(
      "[vitehub] Workspace glob pattern complexity exceeds the model-facing limit of 1024 expansions.",
    )
  })

  it("stays within a bounded child-process heap and deadline", () => {
    const modulePath = fileURLToPath(new URL("../dist/index.js", import.meta.url))
    const script = `
      import { assertModelWorkspaceGlobPattern } from ${JSON.stringify(modulePath)}
      const patterns = [
        '{a,b}'.repeat(1500),
        '{' + Array(400).fill('{000000000000000000000000000000000000000000000000001..100000}').join(',') + '}',
        '{' + '0'.repeat(400000) + '1..100000}',
      ]
      for (const pattern of patterns) {
        try { assertModelWorkspaceGlobPattern(pattern) }
        catch (error) {
          if (!String(error).includes('model-facing limit')) process.exit(2)
          continue
        }
        process.exit(3)
      }
    `
    const result = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "--eval", script], {
      timeout: 2_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
  })
})
