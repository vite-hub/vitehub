import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

import { sha256 } from "../src/core/path.ts"
import { normalizeWorkspaceSource } from "../src/sources/config.ts"

describe("workspace source fingerprints", () => {
  it("hashes byte content from another realm instead of embedding the view", async () => {
    const foreignBytes = runInNewContext("new Uint8Array([1, 2, 3])") as Uint8Array
    const source = normalizeWorkspaceSource("document", { content: foreignBytes, path: "document.bin" })
    const options = source.source.fingerprint?.options as Record<string, unknown>
    const content = options.content as Record<string, unknown>

    expect(content).toEqual({ sha256: await sha256(new Uint8Array([1, 2, 3])) })
  })
})
