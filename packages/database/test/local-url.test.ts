import { describe, expect, it } from "vitest"

import { resolveLocalSqlitePath } from "../src/runtime/local-path.ts"

describe("resolveLocalSqlitePath", () => {
  it("strips the complete file scheme, including localhost URLs", () => {
    expect(resolveLocalSqlitePath("file://localhost/tmp/vitehub/database.sqlite?mode=rwc")).toBe("/tmp/vitehub/database.sqlite")
    expect(resolveLocalSqlitePath("file:/tmp/vitehub/database.sqlite")).toBe("/tmp/vitehub/database.sqlite")
  })
})
