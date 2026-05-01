import { describe, expect, it } from "vitest"

import { serializeSchemaObject } from "../src/internal/schema-serializer.ts"

describe("serializeSchemaObject", () => {
  it("emits file URLs for virtual modules", () => {
    const contents = serializeSchemaObject(
      ["/repo/src/db/schema.ts"],
      "schema",
      true,
    )

    expect(contents).toContain('import * as schema_0 from "file:///repo/src/db/schema.ts";')
    expect(contents).toContain('export * from "file:///repo/src/db/schema.ts";')
  })

  it("normalizes Windows file paths for virtual modules", () => {
    const contents = serializeSchemaObject(
      ["C:\\repo\\src\\db\\schema.ts"],
      "schema",
      true,
    )

    expect(contents).toContain('import * as schema_0 from "file:///C:/repo/src/db/schema.ts";')
    expect(contents).not.toContain('from "C:\\\\repo\\\\src\\\\db\\\\schema.ts"')
  })

  it("emits relative POSIX specifiers for generated files", () => {
    const contents = serializeSchemaObject(
      ["C:\\repo\\src\\db\\schema.ts"],
      "schema",
      true,
      "C:\\repo\\.vitehub\\db\\runtime.mjs",
    )

    expect(contents).toContain('import * as schema_0 from "../../src/db/schema.ts";')
    expect(contents).toContain('export * from "../../src/db/schema.ts";')
  })

  it("falls back to file URLs for cross-drive Windows schema imports", () => {
    const contents = serializeSchemaObject(
      ["D:\\shared\\db\\schema.ts"],
      "schema",
      true,
      "C:\\repo\\.vitehub\\db\\runtime.mjs",
    )

    expect(contents).toContain('import * as schema_0 from "file:///D:/shared/db/schema.ts";')
    expect(contents).toContain('export * from "file:///D:/shared/db/schema.ts";')
    expect(contents).not.toContain("./D:")
  })
})
