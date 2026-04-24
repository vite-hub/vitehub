import { describe, expect, it } from "vitest"

import { resolveEffectiveViteHubServerImports } from "../src/internal/shared/vitehub-server-imports.ts"

describe("resolveEffectiveViteHubServerImports", () => {
  it("does not enable sandbox through a nonexistent Nitro module path", () => {
    expect(resolveEffectiveViteHubServerImports({
      modules: ["@vitehub/sandbox/nitro"],
    })).toEqual([])
  })

  it("still exposes sandbox imports for explicit sandbox setup", () => {
    expect(resolveEffectiveViteHubServerImports({}, "sandbox")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "runSandbox", from: "@vitehub/sandbox" }),
    ]))
  })
})
