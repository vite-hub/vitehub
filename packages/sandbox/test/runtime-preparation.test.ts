import { describe, expect, it, vi } from "vitest"

import {
  pruneSandboxRuntimeGeneration,
  resolveSandboxRuntimeLinkType,
} from "../src/internal/runtime-generation.ts"

describe("Sandbox runtime preparation", () => {
  it("uses junctions for Windows runtime activation", () => {
    expect(resolveSandboxRuntimeLinkType("win32")).toBe("junction")
    expect(resolveSandboxRuntimeLinkType("linux")).toBe("dir")
  })

  it("does not reject an activated refresh when generation pruning fails", async () => {
    const remove = vi.fn(async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" })
    })

    await expect(pruneSandboxRuntimeGeneration("/generated/runtime", remove)).resolves.toBeUndefined()
  })
})
