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
  it("serializes every npm-mutating release", () => {
    expect(workflow).toContain("concurrency:\n  group: npm-release\n  cancel-in-progress: false\n  queue: max")
    expect(workflow).not.toContain("release-${{ github.ref }}")
  })

  it("grants each job only its required authority", () => {
    expect(workflow).toContain("\npermissions: {}\n")
    expect(verify).toMatch(/permissions:\n      contents: read\n/)
    expect(verify).not.toContain("id-token:")
    expect(verify).not.toContain("contents: write")

    expect(publishNpm).toContain("environment: npm-release")
    expect(publishNpm).toContain("Configure required reviewers and release-tag protection")
    expect(publishNpm).toMatch(/permissions:\n      contents: read\n      id-token: write\n/)
    expect(publishNpm).not.toContain("contents: write")

    expect(githubRelease).toMatch(/permissions:\n      contents: write\n/)
    expect(githubRelease).not.toContain("id-token:")
  })

  it("keeps manual and fork runs out of authority-bearing jobs", () => {
    expect(verify).toContain("Dry-run npm package publish")
    expect(verify).not.toContain("Publish packages to npm")
    expect(verify).not.toContain("gh release create")

    const publishGate = "if: needs.verify.outputs.publish == 'true' && github.repository == 'vite-hub/vitehub'"
    expect(publishNpm.indexOf(publishGate)).toBeLessThan(publishNpm.indexOf("    steps:"))
    expect(githubRelease.indexOf(publishGate)).toBeLessThan(githubRelease.indexOf("    steps:"))
    expect(workflow).not.toContain("pull_request_target")
  })
})

describe("release workflow artifact handoff", () => {
  it("uploads one bounded immutable tarball set after verification", () => {
    expect(verify.indexOf("Upload verified release workspace")).toBeGreaterThan(verify.indexOf("Dry-run npm package publish"))
    expect(verify).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1")
    expect(verify).toContain('artifact_name="release-packages-${GITHUB_SHA}-${GITHUB_RUN_ID}"')
    expect(verify).toContain(".release/release-metadata.json")
    expect(verify).toContain(".release/npm")
    expect(verify).not.toMatch(/^\s+packages\s*$/m)
    expect(verify).not.toContain("pnpm-lock.yaml")
    expect(verify).not.toContain("pnpm-workspace.yaml")
    expect(verify).toContain("if-no-files-found: error")
    expect(verify).toContain("overwrite: false")
    expect(verify).not.toMatch(/\n\s+path: (?:\.|\.\/|packages\/\*\*)\s*\n/)
  })

  it("feeds the same verified artifact through npm publication to the GitHub release", () => {
    const uploadPathBlock = verify.match(/- name: Upload verified release workspace[\s\S]*?\n          path: \|\n((?:            \S.*\n)+)/)?.[1]
    if (!uploadPathBlock) throw new Error("Missing release artifact upload paths")
    const uploadPaths = uploadPathBlock.trim().split("\n").map(path => path.trim())
    const uploadRoot = uploadPaths
      .map(path => path.split("/"))
      .reduce((root, path) => root.filter((part, index) => path[index] === part))
      .join("/")
    const downloadedPath = (path: string) => `release-data/${path.slice(uploadRoot.length + 1)}`

    expect(uploadRoot).toBe(".release")
    for (const downstream of [publishNpm, githubRelease]) {
      expect(downstream).toContain("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1")
      expect(downstream).toContain("name: ${{ needs.verify.outputs.artifact_name }}")
      expect(downstream).toContain("EXPECTED_ARTIFACT_DIGEST: ${{ needs.verify.outputs.artifact_digest }}")
    }

    expect(publishNpm).toContain("needs: verify")
    expect(githubRelease).toContain("needs: [verify, publish-npm]")
    expect(githubRelease).not.toContain("actions/checkout@")
    expect(publishNpm).toContain("Checkout trusted release verifier")
    expect(publishNpm).toContain("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0")
    expect(publishNpm).toContain("persist-credentials: false")
    expect(publishNpm).toContain("ref: ${{ github.sha }}")
    expect(publishNpm).toContain('test "$(git -C trusted-source rev-parse HEAD)" = "$GITHUB_SHA"')
    expect(publishNpm).toContain("--workspace trusted-source")
    expect(publishNpm).toContain('--workspace-version "$EXPECTED_VERSION"')
    expect(publishNpm).toContain("trusted-source/.github/scripts/release-packages.mjs publish")
    expect(publishNpm).toContain(`--manifest ${downloadedPath(".release/npm")}/release-manifest.json`)
    expect(publishNpm).toContain('readFileSync("release-metadata.json", "utf8")')
    expect(publishNpm).not.toContain("release-data/.github/scripts")
    expect(publishNpm).not.toContain("vp install")
    expect(publishNpm).not.toContain("package-release-order.mjs")
    expect(publishNpm).not.toContain("vp pm publish")
    expect(publishNpm).toContain("timeout-minutes: 360")
    expect(githubRelease).toContain(`metadata=${downloadedPath(".release/release-metadata.json").replace("release-data/", "")}`)
  })

  it("retains safe resume behavior", () => {
    expect(publishNpm).toContain("release-packages.mjs publish")
    expect(githubRelease).toContain('gh release view "$release_tag"')
    expect(githubRelease).toContain('gh release create "$release_tag"')
  })

  it("validates and dry-runs the exact packed files before upload", () => {
    expect(verify).toContain("const releaseNames = new Set")
    expect(verify).toContain('["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]')
    expect(verify).toContain("manifest[section][name] = process.env.RELEASE_VERSION")
    expect(verify).toContain("--verify-reproducible")
    expect(verify).toContain("release-packages.mjs verify")
    expect(verify).toContain('vp exec --filter @vite-hub/auth -- publint run "$tarball" --strict')
    expect(verify).toContain("VITEHUB_RELEASE_MANIFEST")
    expect(verify).toContain("release-packages.mjs publish")
    expect(verify).toContain("--dry-run")
    expect(verify).not.toContain("vp pm publish")
    expect(verify).not.toContain("package-release-order.mjs")
  })

  it("pins every external action in the OIDC job", () => {
    for (const reference of publishNpm.matchAll(/^\s+- uses: ([^\s]+)(?:\s+#\s+(.+))?$/gm)) {
      const uses = reference[1]!
      if (uses.startsWith("./")) continue
      expect(uses).toMatch(/@[0-9a-f]{40}$/)
      expect(reference[2]).toMatch(/^v\d+\.\d+\.\d+/)
    }
  })
})
