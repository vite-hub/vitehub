import { describe, expect, it } from "vitest"

import { file } from "../src/file.ts"

describe("file workspace paths", () => {
  it("rejects parent traversal in inline workspace paths", () => {
    expect(() => file({ workspacePath: "../outside.txt", content: "secret" })).toThrow()
  })
})
