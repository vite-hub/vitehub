import { describe, expect, it } from "vitest"

import { file } from "../src/file.ts"

describe("file workspace paths", () => {
  it.each(["../outside.txt", "docs/../outside.txt", "/outside.txt", "C:/outside.txt", "C:outside.txt", "..\\outside.txt"])("rejects unsafe workspace path %s", (workspacePath) => {
    expect(() => file({ workspacePath, content: "secret" })).toThrow()
    expect(() => file({ path: "safe.txt", workspacePath })).toThrow()
  })

  it.each(["docs/readme.txt", "docs\\readme.txt"])("preserves safe workspace path %s", async (workspacePath) => {
    const source = file({ workspacePath, content: "hello" })
    expect(await source.getKeys({ rootDir: "." })).toEqual(["docs/readme.txt"])
  })
})
