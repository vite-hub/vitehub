import { expect, it } from "vitest"

import { standardIssuePath } from "../src/standard-schema.ts"

it("formats symbol keys in Standard Schema issue paths", () => {
  expect(standardIssuePath({
    message: "Invalid value",
    path: ["items", 0, { key: Symbol("field") }, Symbol.for("shared")],
  })).toEqual(["items", 0, "Symbol(field)", "Symbol(shared)"])
})

it("keeps numeric path segments and string keys distinct", () => {
  expect(standardIssuePath({ message: "Invalid value", path: [{ key: 2 }, "03", "name"] }))
    .toEqual([2, "03", "name"])
})
