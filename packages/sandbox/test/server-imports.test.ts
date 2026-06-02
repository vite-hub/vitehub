import { describe, expect, it } from "vitest"

import { resolveEffectiveViteHubServerImports } from "../src/internal/shared/vitehub-server-imports.ts"

describe("resolveEffectiveViteHubServerImports", () => {
  it("does not enable features through Nitro module paths", () => {
    expect(resolveEffectiveViteHubServerImports({
      modules: ["@vite-hub/sandbox/nitro"],
    })).toEqual([])
    expect(resolveEffectiveViteHubServerImports({
      modules: ["@vite-hub/kv/nitro"],
    })).toEqual([])
  })

  it("still exposes sandbox imports for explicit sandbox setup", () => {
    expect(resolveEffectiveViteHubServerImports({}, "sandbox")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "runSandbox", from: "@vite-hub/sandbox" }),
    ]))
  })

  it("does not emit stale Prisma database imports", () => {
    expect(resolveEffectiveViteHubServerImports({ db: { orm: "prisma" } }, "db")).toEqual([
      expect.objectContaining({ name: "db", from: "@vite-hub/database/drizzle" }),
      expect.objectContaining({ name: "schema", from: "@vite-hub/database/drizzle" }),
    ])
  })
})
