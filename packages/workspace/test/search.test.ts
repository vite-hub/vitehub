import { describe, expect, it } from "vitest"

import { searchText } from "../src/core/search.ts"

describe("workspace text search", () => {
  it("preserves line numbers, columns, and text with mixed line endings", () => {
    expect(searchText("docs/file.txt", "skip\r\nneedle\nxx needle\r\nneedle\r", { pattern: "needle" })).toEqual([
      { path: "docs/file.txt", line: 2, column: 1, text: "needle" },
      { path: "docs/file.txt", line: 3, column: 4, text: "xx needle" },
      { path: "docs/file.txt", line: 4, column: 1, text: "needle\r" },
    ])
  })

  it.each(["", "\n", "\r\n", "\n\n"])("keeps empty lines, including the final line: %j", (content) => {
    const count = content === "" ? 1 : content === "\n\n" ? 3 : 2
    expect(searchText("file.txt", content, { pattern: "^$", regex: true })).toEqual(
      Array.from({ length: count }, (_, index) => ({ path: "file.txt", line: index + 1, column: 1, text: "" })),
    )
  })

  it("stops at the hit limit within a line", () => {
    expect(searchText("file.txt", "needle needle\nneedle", { pattern: "needle", limit: 1 })).toEqual([
      { path: "file.txt", line: 1, column: 1, text: "needle needle" },
    ])
    expect(searchText("file.txt", "needle", { pattern: "needle", limit: 0 })).toEqual([])
  })

  it("advances past empty regex matches on each line", () => {
    expect(searchText("file.txt", "ab\r\nc", { pattern: "", regex: true })).toEqual([
      { path: "file.txt", line: 1, column: 1, text: "ab" },
      { path: "file.txt", line: 1, column: 2, text: "ab" },
      { path: "file.txt", line: 1, column: 3, text: "ab" },
      { path: "file.txt", line: 2, column: 1, text: "c" },
      { path: "file.txt", line: 2, column: 2, text: "c" },
    ])
  })
})
