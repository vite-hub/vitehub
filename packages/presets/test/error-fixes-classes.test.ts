import { expect, it } from "vitest"

import { presetsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { githubWorkspaceInstallError, isGitHubWorkspaceInstallError } from "../src/github/install.ts"

it("gives the install codes a fix and their own docs page", () => {
  for (const error of [presetsErrorDiagnostics.PRESETS_GITHUB_DEPENDENCY_CONFLICT({ file: "package.json" }), presetsErrorDiagnostics.PRESETS_GITHUB_INSTALL_FAILED({ detail: "d" })]) {
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/presets/diagnostics/${error.code.toLowerCase()}`)
  }
})

it("keeps the cause, kind, and retry decision of a failed install", () => {
  const cause = new Error("ERR_PNPM_OUTDATED_LOCKFILE")
  const error = githubWorkspaceInstallError(cause, false, "input")
  expect(isGitHubWorkspaceInstallError(error)).toBe(true)
  expect(error).toMatchObject({ cause, code: "PRESETS_GITHUB_INSTALL_FAILED", kind: "input", message: "Frozen dependency installation failed: ERR_PNPM_OUTDATED_LOCKFILE", retryable: false })
})
