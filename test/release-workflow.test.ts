import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release.yml"), "utf8")

function job(name: string) {
  const start = workflow.indexOf(`  ${name}:\n`)
  if (start === -1) throw new Error(`Missing ${name} release job`)

  const nextJob = workflow.slice(start + 1).search(/^  [a-z][\w-]*:\n/m)
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob)
}

const verify = job("verify")
const publishNpm = job("publish-npm")
const githubRelease = job("github-release")

describe("release workflow authority", () => {
  it("grants each job only its required authority", () => {
    expect(workflow).toContain("\npermissions: {}\n")
    expect(verify).toMatch(/permissions:\n      contents: read\n/)
    expect(verify).not.toContain("id-token:")
    expect(verify).not.toContain("contents: write")

    expect(publishNpm).toContain("environment: npm-release")
    expect(publishNpm).toContain("Configure required reviewers and release-tag protection")
    expect(publishNpm).toMatch(/permissions:\n      contents: read\n      id-token: write\n/)
    expect(publishNpm).not.toContain("contents: write")
    expect(publishNpm).toContain("voidzero-dev/setup-vp@1b32467adbe183473499fd9d5d372c3ed9641754 # v1.18.0")
    expect(publishNpm).not.toContain("voidzero-dev/setup-vp@v1")

    expect(githubRelease).toMatch(/permissions:\n      contents: write\n/)
    expect(githubRelease).not.toContain("id-token:")
  })

  it("keeps manual and fork runs out of authority-bearing jobs", () => {
    expect(verify).toContain("Dry-run npm package publish")
    expect(verify).not.toContain("Publish packages to npm")
    expect(verify).not.toContain("gh release create")

    const publishGate = "if: github.event_name == 'push' && needs.verify.outputs.publish == 'true' && github.repository == 'vite-hub/vitehub'"
    for (const authorityJob of [publishNpm, githubRelease]) {
      expect(authorityJob).toContain(publishGate)
      expect(authorityJob.indexOf(publishGate)).toBeLessThan(authorityJob.indexOf("    steps:"))
    }
    expect(workflow).not.toContain("pull_request_target")
  })
})

describe("release workflow artifact handoff", () => {
  it("uploads one bounded immutable workspace after verification", () => {
    expect(verify.indexOf("Upload verified release workspace")).toBeGreaterThan(verify.indexOf("Dry-run npm package publish"))
    expect(verify).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1")
    expect(verify).toContain('artifact_name="release-workspace-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"')
    expect(verify).toContain("runAttempt: process.env.GITHUB_RUN_ATTEMPT")
    expect(verify).toContain(".release/release-metadata.json")
    expect(verify).toContain(".release/package-order.txt")
    expect(verify).toContain("pnpm-lock.yaml")
    expect(verify).toContain("pnpm-workspace.yaml")
    expect(verify).toContain("!packages/**/node_modules/**")
    expect(verify).toContain("if-no-files-found: error")
    expect(verify).toContain("overwrite: false")
    expect(verify).not.toMatch(/\n\s+path: (?:\.|\.\/|packages\/\*\*)\s*\n/)
  })

  it("feeds the same verified artifact through npm publication to the GitHub release", () => {
    for (const downstream of [publishNpm, githubRelease]) {
      expect(downstream).toContain("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1")
      expect(downstream).toContain("name: ${{ needs.verify.outputs.artifact_name }}")
      expect(downstream).toContain("EXPECTED_ARTIFACT_DIGEST: ${{ needs.verify.outputs.artifact_digest }}")
      expect(downstream).not.toContain("GITHUB_RUN_ATTEMPT")
      expect(downstream).not.toContain("actions/checkout@")
    }

    expect(publishNpm).toContain("needs: verify")
    expect(githubRelease).toContain("needs: [verify, publish-npm]")
    expect(publishNpm.indexOf("Restore local workspace links")).toBeLessThan(publishNpm.indexOf("Publish packages to npm"))
    expect(publishNpm).not.toContain("vp install")
    expect(publishNpm).not.toContain("package-release-order.mjs")
    expect(publishNpm).toContain('vp pm publish --access public --tag "$NPM_TAG" --ignore-scripts --no-git-checks')
  })

  it("retains safe resume behavior", () => {
    expect(verify).toContain("-${GITHUB_RUN_ATTEMPT}")
    for (const downstream of [publishNpm, githubRelease]) {
      expect(downstream).toContain("needs.verify.outputs.artifact_name")
      expect(downstream).not.toContain("process.env.GITHUB_RUN_ATTEMPT")
    }
    expect(publishNpm).toContain('npm view "${package_name}@${package_version}"')
    expect(publishNpm).toContain("is already published; skipping.")
    expect(githubRelease).toContain('gh release view "$release_tag"')
    expect(githubRelease).toContain('gh release create "$release_tag"')
  })
})
