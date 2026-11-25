import { setTimeout as sleep } from "node:timers/promises"

import { parse } from "sh-syntax"
import { describe, expect, it, vi } from "vitest"

import { analyzeShellCommand } from "../src/command/analyze.ts"

vi.mock("sh-syntax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sh-syntax")>()
  return { ...actual, parse: vi.fn(actual.parse) }
})

vi.mock("sh-syntax/main.wasm?module", async () => {
  await sleep(250)
  return { default: undefined }
})

const webAssembly = (globalThis as unknown as { WebAssembly: { instantiate: (module: object, imports: object) => Promise<object> } }).WebAssembly

describe("shell analysis on a cold server", () => {
  it("retries failed initialization and excludes the first successful load from the time limit", async () => {
    const instantiate = webAssembly.instantiate.bind(webAssembly)
    const wasm = vi.spyOn(webAssembly, "instantiate")
      .mockRejectedValueOnce(new Error("transient WASM initialization failure"))
      .mockImplementationOnce(async (module, imports) => {
        await sleep(250)
        return instantiate(module, imports)
      })
    try {
      await expect(analyzeShellCommand("echo ok")).resolves.toEqual({
        error: "transient WASM initialization failure",
        ok: false,
        parser: "sh-syntax",
      })
      await expect(analyzeShellCommand("cat notes.txt | grep ship")).resolves.toEqual({
        commands: ["cat", "grep"],
        hasCommandSubstitution: false,
        hasHeredocs: false,
        hasPipelines: true,
        hasRedirects: false,
        ok: true,
        parser: "sh-syntax",
      })
      expect(wasm).toHaveBeenCalledTimes(2)
    }
    finally {
      wasm.mockRestore()
    }
  })

  it("still times out when the parse does not finish", async () => {
    vi.mocked(parse).mockReturnValueOnce(new Promise<Awaited<ReturnType<typeof parse>>>(() => {}))
    await expect(analyzeShellCommand("echo ok", { timeoutMs: 10 })).resolves.toEqual({
      error: "Shell analysis timed out after 10ms.",
      ok: false,
      parser: "sh-syntax",
    })
  })
})
