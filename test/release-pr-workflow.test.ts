import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")
const workflow = readFileSync(resolve(root, ".github/workflows/release-pr.yml"), "utf8")
const checker = resolve(root, ".github/scripts/check-release-candidate.mjs")

describe("release PR workflow", () => {
  it("gates tag creation on the merged commit's full verification", () => {
    expect(workflow).toContain("danielroe/uppt/pr@7bcfb5397c37202ef882363f755423130419d28a # v0.5.5")
    expect(workflow).toContain("group: release-proposal\n      cancel-in-progress: false")
    expect(workflow).toContain('live_sha="$(gh api "repos/${GITHUB_REPOSITORY}/branches/main" --jq .commit.sha)"')
    expect(workflow).toContain("if: steps.current.outputs.current == 'true'")
    expect(workflow).toContain("Reconcile the latest release merge")
    expect(workflow).toContain(".head.repo.full_name == .base.repo.full_name")
    expect(workflow).toContain('git merge-base --is-ancestor "$parent_sha" "$tag_sha"')
    expect(workflow).toContain('if [[ -z "$tag_sha" || "$tag_sha" == "$GITHUB_SHA" ]]')
    expect(workflow).toContain("gh pr close \"$pr\" --repo \"$GITHUB_REPOSITORY\" --delete-branch")
    expect(workflow).toContain("steps.pending-release.outputs.pending != 'true'")
    expect(workflow).toContain('checkout: "false"')
    expect(workflow).toContain("packages/*")
    expect(workflow).toContain("gh workflow run ci.yml --repo")
    expect(workflow).toContain("actions: write")
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository")
    expect(workflow).toContain("ref: ${{ github.event.pull_request.merge_commit_sha }}")
    expect(workflow).toContain("vp run verify")
    expect(workflow).toContain("needs: verify-release")
    expect(workflow).toContain("if: needs.verify-release.result == 'success'")
    expect(workflow).toContain('existing_sha" != "$RELEASE_SHA')
    expect(workflow).toContain('gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref "$release_tag"')
    expect(workflow).toContain('gh workflow run release-pr.yml --repo "$GITHUB_REPOSITORY" --ref main')
    expect(workflow).not.toContain("pull_request_target")
  })

  it("rejects a branch or package version mismatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-release-pr-"))
    try {
      mkdirSync(join(directory, "packages", "public"), { recursive: true })
      mkdirSync(join(directory, "packages", "private"))
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.1.0" }))
      writeFileSync(join(directory, "packages", "public", "package.json"), JSON.stringify({ name: "public", version: "0.1.0" }))
      writeFileSync(join(directory, "packages", "private", "package.json"), JSON.stringify({ name: "private", version: "0.0.1", private: true }))

      const check = (branch: string) => execFileSync("node", [checker, branch], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      expect(check("release/v0.1.0")).toContain("Validated 1 packages at 0.1.0")
      expect(() => check("release/v0.0.1")).toThrow()
      expect(() => check("release/other")).toThrow()
      expect(() => check("release/v0.1.0-01")).toThrow()
      writeFileSync(join(directory, "packages", "public", "package.json"), JSON.stringify({ name: "public", version: "0.0.1" }))
      expect(() => check("release/v0.1.0")).toThrow()
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
