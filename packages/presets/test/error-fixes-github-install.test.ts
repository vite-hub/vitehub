import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { presetsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createGitHubHost } from "../src/github/host.ts"
import { assertGitHubDependenciesCurrent, installGitHubPullRequestWorkspace } from "../src/github/install.ts"

const codes = [
  "PRESETS_CHECKOUT_CLEANUP_FAILED",
  "PRESETS_COREPACK_MISSING",
  "PRESETS_DEPENDENCIES_NOT_CURRENT",
  "PRESETS_DEPENDENCY_CONFLICT_UNRESOLVED",
  "PRESETS_DEPENDENCY_GIT_HOST_LOCAL",
  "PRESETS_DEPENDENCY_GIT_UNSUPPORTED",
  "PRESETS_DEPENDENCY_HOST_UNTRUSTED",
  "PRESETS_DEPENDENCY_INPUTS_CHANGED",
  "PRESETS_DEPENDENCY_INPUT_SYMLINK",
  "PRESETS_DEPENDENCY_PATCHES_INVALID",
  "PRESETS_DEPENDENCY_PATCH_NOT_FILE",
  "PRESETS_DEPENDENCY_PATCH_PATH_INVALID",
  "PRESETS_DEPENDENCY_PATH_HOST_LOCAL",
  "PRESETS_DEPENDENCY_PATH_OUTSIDE",
  "PRESETS_DEPENDENCY_PROTOCOL_UNSUPPORTED",
  "PRESETS_DEPENDENCY_SYMLINK_OUTSIDE",
  "PRESETS_DEPENDENCY_URL_INVALID",
  "PRESETS_GITHUB_APP_CREDENTIALS_INCOMPLETE",
  "PRESETS_GITHUB_APP_NUMBER_INVALID",
  "PRESETS_GITHUB_APP_REQUEST_FAILED",
  "PRESETS_GITHUB_APP_RESPONSE_INVALID",
  "PRESETS_GITHUB_APP_TOKEN_FAILED",
  "PRESETS_GITHUB_APP_TOKEN_MISSING",
  "PRESETS_GITHUB_AUTH_MISSING",
  "PRESETS_GITHUB_HOST_APP_OWNER_MISSING",
  "PRESETS_GITHUB_REPOSITORY_INVALID",
  "PRESETS_INSTALL_OUTPUT_CHANGED",
  "PRESETS_LINKED_BIN_CHANGED",
  "PRESETS_LINKED_BIN_GIT_METADATA",
  "PRESETS_LINKED_BIN_INVALID",
  "PRESETS_LINKED_BIN_NOT_FILE",
  "PRESETS_LINKED_BIN_OUTSIDE",
  "PRESETS_LOCAL_DEPENDENCY_CONTENTS_INVALID",
  "PRESETS_LOCKFILE_MISSING",
  "PRESETS_NPM_CONFIG_UNSUPPORTED",
  "PRESETS_NPM_VERSION_UNSUPPORTED",
  "PRESETS_NPM_WORKSPACE_LINK_INVALID",
  "PRESETS_PACKAGE_MANAGER_UNSUPPORTED",
  "PRESETS_PNPM_CONFIG_UNSUPPORTED",
  "PRESETS_PULL_REQUEST_HEAD_CHANGED",
  "PRESETS_PULL_REQUEST_HEAD_REF_INVALID",
  "PRESETS_PULL_REQUEST_HEAD_REF_MISSING",
  "PRESETS_PULL_REQUEST_HEAD_SHA_INVALID",
  "PRESETS_PULL_REQUEST_PUSH_TARGET_MISSING",
  "PRESETS_PUSH_TARGET_HEAD_INVALID",
  "PRESETS_PUSH_TARGET_INVALID",
  "PRESETS_WORKSPACE_INSTALL_FAILED",
  "PRESETS_YARN_LOCKFILE_INVALID",
  "PRESETS_YARN_OUTPUT_INVALID",
  "PRESETS_YARN_PATCH_SELECTOR_INVALID",
] as const

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function checkout(manifest: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-error-fixes-"))
  roots.push(root)
  await mkdir(join(root, ".git"))
  await writeFile(join(root, "package.json"), JSON.stringify(manifest))
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  return root
}

it("gives each GitHub install and host code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: Each code reads only the params that its `why` names; the loop checks the static fields.
    const error = (presetsErrorDiagnostics[code] as (params: { message: string }) => Error & { fix?: string, docs?: string })({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports a host without GitHub credentials with a code and a fix", async () => {
  const host = createGitHubHost({ credentials: () => ({}) })
  await expect(host.access({ repository: "acme/app" })).rejects.toMatchObject({
    code: "PRESETS_GITHUB_AUTH_MISSING",
    fix: expect.stringContaining("VITEHUB_GITHUB_TOKEN"),
    message: "GitHub authentication is not configured. Set VITEHUB_GITHUB_TOKEN or GitHub App credentials.",
  })
})

it("reports a short pull request head SHA with a code and a fix", async () => {
  const host = createGitHubHost({ credentials: () => ({ token: "token" }) })
  await expect(host.withPullRequestCheckout({ repository: "acme/app", number: 1, headSha: "abc123" }, async () => undefined)).rejects.toMatchObject({
    code: "PRESETS_PULL_REQUEST_HEAD_SHA_INVALID",
    fix: expect.stringContaining("headSha"),
  })
})

it("reports a dependency path outside the checkout with a code and a fix", async () => {
  const root = await checkout({ dependencies: { secret: "file:~/private" } })
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toMatchObject({
    code: "PRESETS_DEPENDENCY_PATH_HOST_LOCAL",
    fix: expect.stringContaining("relative path inside the checkout"),
  })
})

it("keeps the code and the fix on the cause of a failed install", async () => {
  const root = await checkout({ packageManager: "yarn@4.0.0" })
  await expect(installGitHubPullRequestWorkspace(root)).rejects.toMatchObject({
    retryable: false,
    cause: { code: "PRESETS_PACKAGE_MANAGER_UNSUPPORTED", fix: expect.stringContaining("packageManager in package.json") },
  })
})
