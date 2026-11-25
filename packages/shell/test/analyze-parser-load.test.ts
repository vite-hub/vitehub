import { setTimeout as sleep } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import { analyzeShellCommand } from "../src/command/analyze.ts"

vi.mock("sh-syntax/main.wasm?module", async () => {
  await sleep(250)
  return { default: undefined }
})

describe("shell analysis on a cold server", () => {
  it("does not count the first parser load against the parse time limit", async () => {
    await expect(analyzeShellCommand("cat notes.txt | grep ship", { timeoutMs: 100 })).resolves.toEqual({
      commands: ["cat", "grep"],
      hasCommandSubstitution: false,
      hasHeredocs: false,
      hasPipelines: true,
      hasRedirects: false,
      ok: true,
      parser: "sh-syntax",
    })
  })
})
