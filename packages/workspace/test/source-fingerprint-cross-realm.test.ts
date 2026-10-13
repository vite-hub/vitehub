import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

import { sha256 } from "../src/core/path.ts"
import { normalizeWorkspaceSource } from "../src/sources/config.ts"

describe("workspace source fingerprints", () => {
  it("hashes byte content from another realm instead of embedding the view", async () => {
    const foreignBytes = runInNewContext("new Uint8Array([1, 2, 3])") as Uint8Array
    const source = normalizeWorkspaceSource("document", { content: foreignBytes, path: "document.bin" } as never)
    const options = (source.source.fingerprint as { options?: Record<string, unknown> } | undefined)?.options ?? {}
    const content = options.content as Record<string, unknown>

    expect(content).toEqual({ sha256: await sha256(new Uint8Array([1, 2, 3])) })
  })

  it("does not trust spoofed typed-array tags or invoke hostile tag getters", () => {
    const spoofed = runInNewContext(`(() => {
      const value = new Uint16Array([1, 2, 3])
      Object.defineProperty(value, Symbol.toStringTag, { value: "Uint8Array" })
      return value
    })()`) as Uint16Array
    const hostile = runInNewContext(`(() => {
      const value = new Uint16Array([4, 5, 6])
      Object.defineProperty(value, Symbol.toStringTag, { get() { throw new Error("tag accessed") } })
      return value
    })()`) as Uint16Array

    for (const content of [spoofed, hostile]) {
      const source = normalizeWorkspaceSource("document", { content, path: "document.bin" } as never)
      const options = (source.source.fingerprint as { options?: Record<string, unknown> } | undefined)?.options
      expect(options?.content).toBe(content)
    }
  })
})
