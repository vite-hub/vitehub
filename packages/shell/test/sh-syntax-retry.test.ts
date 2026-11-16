import { describe, expect, it, vi } from "vitest"

import { parseShellCommand } from "../src/command/parse.ts"

// The parser fails to load once, as an import can fail when a dependency is reinstalled during development.
const shSyntax = vi.hoisted(() => ({ failures: 1 }))

vi.mock("sh-syntax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sh-syntax")>()
  return {
    ...actual,
    get parse() {
      if (shSyntax.failures > 0) {
        shSyntax.failures--
        throw new Error("transient sh-syntax load failure")
      }
      return actual.parse
    },
  }
})

describe("shell command parsing", () => {
  it("loads the parser again on the next parse after a failed load", async () => {
    await expect(parseShellCommand("echo hello")).rejects.toThrow("transient sh-syntax load failure")
    await expect(parseShellCommand("echo hello")).resolves.toEqual(["echo", "hello"])
  })
})
