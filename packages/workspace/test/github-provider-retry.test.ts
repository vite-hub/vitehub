import { describe, expect, it, vi } from "vitest"

import { connectGitHubRepository } from "../src/providers/github/shared.ts"

// The Forge provider fails to load once, as an import can fail when a dependency is reinstalled during development.
const forge = vi.hoisted(() => ({ failures: 1 }))

vi.mock("@vite-hub/forge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/forge")>()
  return {
    ...actual,
    forgeProvider: async (...args: Parameters<typeof actual.forgeProvider>) => {
      if (forge.failures > 0) {
        forge.failures--
        throw new Error("transient Forge provider failure")
      }
      return await actual.forgeProvider(...args)
    },
  }
})

describe("GitHub repository connections", () => {
  it("loads the provider again on the next request after a failed load", async () => {
    const repository = connectGitHubRepository("onmax/repo", "token")

    await expect(repository.provider()).rejects.toThrow("transient Forge provider failure")
    await expect(repository.provider()).resolves.toBeDefined()
  })
})
