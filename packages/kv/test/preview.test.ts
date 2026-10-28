import { expect, it } from "vitest"

import { previewKVValue } from "../src/runtime/preview.ts"

it.each([9007199254740993n, { nested: [42n] }, new Date("2026-01-01"), new Map([["role", "admin"]]), new Set([1]), new Uint8Array([1, 2]), { nested: undefined }, [undefined], Number.NaN, Number.POSITIVE_INFINITY, -0])("keeps a lossy native preview read-only: %s", value => {
  expect(previewKVValue(value)).toMatchObject({ editable: false })
})

it.each(["hello", 42, false, null, { nested: [1, "hello", null] }])("allows editing JSON values without changing their type or value: %j", value => {
  const preview = previewKVValue(value)
  expect(preview.editable).toBe(true)
  expect(preview.type === "string" ? preview.value : JSON.parse(preview.value)).toEqual(value)
})

it("keeps truncated previews read-only", () => {
  expect(previewKVValue("a".repeat(256 * 1024 + 1))).toMatchObject({ editable: false, truncated: true })
})
