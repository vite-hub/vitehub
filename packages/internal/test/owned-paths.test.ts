import { describe, expect, it } from "vitest"

import { isVitehubOwnedPath, vitehubOwnedPrefix } from "../src/owned-paths.ts"

describe("ViteHub-owned Blob paths", () => {
  it("uses one prefix", () => {
    expect(vitehubOwnedPrefix).toBe("_vitehub/")
  })

  it.each([
    "_vitehub",
    "_vitehub/",
    "_vitehub/workspace-history/abc",
    "_vitehub/console/attachments/id",
    "/_vitehub/media/a.png",
    "_VITEHUB/derived/x",
    "_vitehub\\console\\cleanup\\id",
    "elsewhere/../_vitehub/x",
    "./_vitehub/x",
  ])("owns %s", (pathname) => {
    expect(isVitehubOwnedPath(pathname)).toBe(true)
  })

  it.each([
    "",
    "vitehub/workspace-history/abc",
    "vitehub-console-attachments/id",
    "_vitehubx/a",
    "media/_vitehub/a",
    "_vitehub-media/a",
  ])("does not own %s", (pathname) => {
    expect(isVitehubOwnedPath(pathname)).toBe(false)
  })
})
