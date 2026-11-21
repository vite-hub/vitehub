import { Diagnostic } from "nostics"
import { expect, it } from "vitest"

import { checkoutFailure } from "../src/checkout.ts"
import { workspaceErrorDiagnostics } from "../src/error-diagnostics.ts"
import { runWorkspaceOperation } from "../src/runtime/operations.ts"

/** A diagnostic from another bundled copy of Nostics: the same fields, but not an instance of this copy's `Diagnostic`. */
class OtherCopyDiagnostic extends Error {
  readonly code: string
  readonly fix: string
  constructor(code: string, why: string, fix: string) {
    super(why)
    this.code = this.name = code
    this.fix = fix
  }

  get why(): string {
    return this.message
  }

  toJSON(): { fix: string, name: string, why: string } {
    return { fix: this.fix, name: this.name, why: this.why }
  }
}

const codes = {
  WORKSPACE_CHECKOUT_CONFLICT: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_CONFLICT({ conflicted: "a.md", workspace: "docs" }),
  WORKSPACE_CHECKOUT_DIR: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_DIR({ workspace: "docs" }),
  WORKSPACE_CHECKOUT_FAILED: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_FAILED({ message: "m" }),
  WORKSPACE_CHECKOUT_MISSING: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_MISSING({}),
  WORKSPACE_CHECKOUT_OPTIONS: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_OPTIONS({ actual: "b", expected: "a", key: "ref", workspace: "docs" }),
  WORKSPACE_CHECKOUT_OVERLAP: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_OVERLAP({ dir: "a", other: "b", otherDir: "a/b", workspace: "docs" }),
  WORKSPACE_CHECKOUT_PATH: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_PATH({ path: "a", problem: "excluded" }),
  WORKSPACE_CHECKOUT_SYMLINK: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_SYMLINK({ path: "vitehub.lock" }),
  WORKSPACE_CHECKOUT_TOO_LARGE: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_TOO_LARGE({ largest: "", limit: "4 MB", size: "5 MB", workspace: "docs" }),
  WORKSPACE_CHECKOUT_USAGE: workspaceErrorDiagnostics.WORKSPACE_CHECKOUT_USAGE({ flag: "x", problem: "flag" }),
  WORKSPACE_FORBIDDEN: workspaceErrorDiagnostics.WORKSPACE_FORBIDDEN(),
  WORKSPACE_HISTORY_FAILED: workspaceErrorDiagnostics.WORKSPACE_HISTORY_FAILED({ workspace: "docs" }),
  WORKSPACE_HISTORY_INVALID: workspaceErrorDiagnostics.WORKSPACE_HISTORY_INVALID({ problem: "empty-commit" }),
  WORKSPACE_LOCK_BUSY: workspaceErrorDiagnostics.WORKSPACE_LOCK_BUSY(),
  WORKSPACE_LOCK_INVALID: workspaceErrorDiagnostics.WORKSPACE_LOCK_INVALID({ problem: "json" }),
  WORKSPACE_NOT_FOUND: workspaceErrorDiagnostics.WORKSPACE_NOT_FOUND({ problem: "workspace", workspace: "docs" }),
}

it("gives each code that replaced an error class a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/workspace/diagnostics/${code.toLowerCase()}`)
  }
})

it("gives a history operation failure its code, fix, and HTTP status", async () => {
  await expect(runWorkspaceOperation("history", { cursor: "c", workspace: "docs" })).rejects.toMatchObject({
    code: "WORKSPACE_HISTORY_INVALID",
    fix: expect.stringContaining("`cursor`"),
    status: 400,
    statusMessage: "The cursor belongs to one ref. Pass the same ref.",
  })
})

it("prints a failure without a code as WORKSPACE_CHECKOUT_FAILED with a fix", () => {
  expect(checkoutFailure(new Error("disk full"))).toEqual({ code: "WORKSPACE_CHECKOUT_FAILED", fix: expect.stringContaining("vitehub status"), message: "disk full" })
  expect(checkoutFailure(workspaceErrorDiagnostics.WORKSPACE_LOCK_BUSY())).toMatchObject({ code: "WORKSPACE_LOCK_BUSY", fix: expect.stringContaining("vitehub.lock.lock") })
})

it("prints a diagnostic from another copy of Nostics with its own code and fix", () => {
  const error = new OtherCopyDiagnostic("AGENT_BUSY", "The Agent is busy.", "Try again later.")
  expect(error).not.toBeInstanceOf(Diagnostic)
  expect(checkoutFailure(error)).toEqual({ code: "AGENT_BUSY", fix: "Try again later.", message: "The Agent is busy." })
})
