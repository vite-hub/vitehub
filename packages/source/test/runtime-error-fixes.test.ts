import { describe, expect, it } from "vitest"

import { CollectionAccessError } from "../src/client.ts"
import { sourceErrorDiagnostics } from "../src/error-diagnostics.ts"
import { CollectionCursorError, defineCollection, file } from "../src/index.ts"
import { defineCollectionHandler } from "../src/server.ts"

const runtimeCodes = [
  "SOURCE_R0001", "SOURCE_R0002", "SOURCE_R0003", "SOURCE_R0004", "SOURCE_R0005",
  "SOURCE_R0006", "SOURCE_R0008", "SOURCE_R0009", "SOURCE_R0011", "SOURCE_R0012",
  "SOURCE_R0013", "SOURCE_R0014", "SOURCE_R0015", "SOURCE_R0016", "SOURCE_R0017",
  "SOURCE_R0018", "SOURCE_R0021", "SOURCE_R0022", "SOURCE_R0023", "SOURCE_R0024",
  "SOURCE_R0025", "SOURCE_R0026", "SOURCE_R0027", "SOURCE_R0028", "SOURCE_R0029",
  "SOURCE_R0030", "SOURCE_R0031", "SOURCE_R0032", "SOURCE_R0033",
] as const

describe("Source runtime error fixes", () => {
  it.each(runtimeCodes)("gives %s a fix and its own docs page", (code) => {
    const error = sourceErrorDiagnostics[code]({ message: "m" })
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/source/diagnostics/${code.toLowerCase()}`)
  })

  it("names the limits of defineCollection()", () => {
    expect(() => defineCollection(async () => [], { defaultLimit: 50, maxLimit: 10 } as never)).toThrow(expect.objectContaining({
      code: "SOURCE_R0008",
      fix: expect.stringContaining("`maxLimit`"),
    }))
  })

  it("names the options of file()", () => {
    expect(() => file({} as never)).toThrow(expect.objectContaining({
      code: "SOURCE_R0017",
      fix: expect.stringContaining("`workspacePath`"),
    }))
  })

  it("names defineCollection() for a handler without a Collection", () => {
    expect(() => defineCollectionHandler({} as never)).toThrow(expect.objectContaining({
      code: "SOURCE_R0016",
      fix: expect.stringContaining("defineCollection()"),
    }))
  })

  it("puts the catalog fix on Collection cursor and access errors", () => {
    expect(new CollectionCursorError()).toMatchObject({ code: "SOURCE_R0023", fix: sourceErrorDiagnostics.SOURCE_R0023({ message: "" }).fix })
    expect(new CollectionCursorError(undefined, { reason: "stale" })).toMatchObject({ code: "SOURCE_R0027", fix: expect.stringContaining("first page") })
    expect(new CollectionAccessError(401)).toMatchObject({ code: "SOURCE_R0026", fix: expect.stringContaining("`authorize`") })
  })
})
