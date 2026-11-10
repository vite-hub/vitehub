import { describe, expect, it } from "vitest"

import { isPlainObject, isPlainRecord, isRecord, isRecordOrFunction } from "../src/object.ts"

class Point {
  x = 1
}

const cases: [name: string, value: unknown, record: boolean, recordOrFunction: boolean, plainRecord: boolean][] = [
  ["object literal", { a: 1 }, true, true, true],
  ["null prototype", Object.create(null), true, true, true],
  ["class instance", new Point(), true, true, false],
  ["date", new Date(0), true, true, false],
  ["array", [], false, false, false],
  ["function", () => {}, false, true, false],
  ["null", null, false, false, false],
  ["undefined", undefined, false, false, false],
  ["string", "a", false, false, false],
  ["number", 1, false, false, false],
]

describe("object guards", () => {
  it.each(cases)("%s", (_name, value, record, recordOrFunction, plainRecord) => {
    expect(isRecord(value)).toBe(record)
    expect(isPlainObject(value)).toBe(record)
    expect(isRecordOrFunction(value)).toBe(recordOrFunction)
    expect(isPlainRecord(value)).toBe(plainRecord)
  })
})
