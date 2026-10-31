import { expect, it } from "vitest"

import { consoleDatabaseNumericColumns } from "../src/console/runtime/components/console-database-model"

it("aligns a column as numbers only when every value on the page is a number", () => {
  const columns = consoleDatabaseNumericColumns([
    { count: { kind: "number", value: "3" }, id: { kind: "text", value: "rl_01" }, mixed: { kind: "number", value: "1" }, total: { kind: "bigint", value: "9007199254740993" } },
    { count: { kind: "null", value: "NULL" }, id: { kind: "text", value: "rl_02" }, mixed: { kind: "text", value: "n/a" }, total: { kind: "bigint", value: "2" } },
  ])
  expect([...columns].sort()).toEqual(["count", "total"])
})

it("treats a column of only NULL values as text", () => {
  expect(consoleDatabaseNumericColumns([{ deletedAt: { kind: "null", value: "NULL" } }]).size).toBe(0)
})
