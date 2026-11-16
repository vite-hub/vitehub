import { describe, expect, it } from "vitest"

import { parseShellCommand } from "../src/command/parse.ts"
import { shellErrorDiagnostics } from "../src/error-diagnostics.ts"
import { cleanWorkspaceMutationPath, cleanWorkspaceShellPath } from "../src/workspace/index.ts"

describe("Shell error fixes", () => {
  it("gives each Shell code a fix and its own docs page", () => {
    for (const [code, create] of Object.entries(shellErrorDiagnostics)) {
      const error = create({ message: "m" })
      expect(error.fix, code).toMatch(/\S/)
      expect(error.docs, code).toBe(`https://vitehub.dev/docs/shell/diagnostics/${code.toLowerCase()}`)
    }
  })

  it("refuses the Workspace root as a mutation target", () => {
    expect(() => cleanWorkspaceMutationPath("/workspace")).toThrow(expect.objectContaining({
      code: "SHELL_R0020",
      fix: expect.stringContaining("below the Workspace root"),
    }))
  })

  it("tells the caller to stay inside the Workspace", () => {
    expect(() => cleanWorkspaceShellPath("../secrets")).toThrow(expect.objectContaining({
      code: "SHELL_R0021",
      fix: expect.stringContaining("`/workspace`"),
    }))
  })

  it("asks for valid shell syntax", async () => {
    await expect(parseShellCommand("echo \"open")).rejects.toMatchObject({
      code: "SHELL_R0003",
      fix: expect.stringContaining("shell syntax"),
    })
  })
})
