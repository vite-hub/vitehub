import { describe, expect, it, vi } from "vitest"

import { github } from "../../src/sources/github/lazy.ts"

// The GitHub Source fails to load once, as an import can fail during a development rebuild.
const loader = vi.hoisted(() => ({ failures: 1 }))

vi.mock("../../src/sources/github/index.ts", () => {
  if (loader.failures > 0) {
    loader.failures--
    throw new Error("transient GitHub Source import failure")
  }
  return { github: () => ({ getKeys: async () => ["README.md"] }) }
})

describe("@vite-hub/source GitHub source", () => {
  it("loads the Source again on the next read after a failed load", async () => {
    const source = github({ repo: "onmax/repo" })
    const context = { rootDir: process.cwd() }

    await expect(source.getKeys(context)).rejects.toThrow()
    await expect(source.getKeys(context)).resolves.toEqual(["README.md"])
  })
})
