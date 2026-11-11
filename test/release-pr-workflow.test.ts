import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

import { describe, expect, it } from "vitest"
import { parseAllDocuments } from "yaml"

const root = resolve(import.meta.dirname, "..")
const workflow = readFileSync(resolve(root, ".github/workflows/release-pr.yml"), "utf8")
const checker = resolve(root, ".github/scripts/check-release-candidate.mjs")

describe("release PR workflow", () => {
  it("gates tag creation on the merged commit's full verification", () => {
    expect(workflow).toContain("danielroe/uppt/pr@6c1a9b480b0f02a3f535dedaf1a113f590aa56f2 # v0.6.12")
    expect(workflow).toContain("group: release-proposal\n      cancel-in-progress: false")
    expect(workflow).toContain('live_sha="$(gh api "repos/${GITHUB_REPOSITORY}/branches/main" --jq .commit.sha)"')
    expect(workflow).toContain("if: steps.current.outputs.current == 'true'")
    expect(workflow).toContain("Reconcile the latest release merge")
    expect(workflow).toContain("recover_failed_release:")
    expect(workflow).toContain("recovery_pr:")
    expect(workflow).toContain("  recover-release:\n")
    expect(workflow).toContain('node .github/scripts/check-release-candidate.mjs "$release_branch"')
    expect(workflow).toContain('release_tag="${release_branch#release/}"')
    expect(workflow).toContain('gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref "$RELEASE_TAG"')
    expect(workflow).toContain(".head.repo.full_name == .base.repo.full_name")
    expect(workflow).toContain('git merge-base --is-ancestor "$parent_sha" "$tag_sha"')
    expect(workflow).toContain('if [[ -z "$tag_sha" || "$tag_sha" == "$GITHUB_SHA" ]]')
    expect(workflow).toContain("gh pr close \"$pr\" --repo \"$GITHUB_REPOSITORY\" --delete-branch")
    expect(workflow).toContain("steps.pending-release.outputs.pending != 'true'")
    expect(workflow).toContain('checkout: "false"')
    expect(workflow).toContain("packages/*")
    expect(workflow).toContain("for workflow in ci.yml pkg-pr-new.yml; do")
    expect(workflow).toContain('actions/workflows/${workflow}/runs?head_sha=${head_sha}')
    expect(workflow).toContain('select(.status == "completed" and .conclusion == "success")')
    expect(workflow).toContain('gh workflow run "$workflow" --repo "$GITHUB_REPOSITORY" --ref "$release_branch"')
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

  it("pushes the completed bump before dispatching release checks", () => {
    const bump = workflow.indexOf('node "$GITHUB_WORKSPACE/.github/scripts/check-release-candidate.mjs" "$release_branch" --bump')
    const lockfile = workflow.indexOf("corepack pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile")
    const push = workflow.indexOf('push origin "HEAD:refs/heads/$release_branch"')
    const head = workflow.indexOf('head_sha="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/${release_branch}"')
    const dispatch = workflow.indexOf('gh workflow run "$workflow"')
    expect(bump).toBeGreaterThan(-1)
    expect(lockfile).toBeGreaterThan(bump)
    expect(push).toBeGreaterThan(lockfile)
    expect(head).toBeGreaterThan(push)
    expect(dispatch).toBeGreaterThan(head)
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

  it.each(["0.2.0", "0.2.1", "1.0.0-rc.1"])("bumps release peers and codemod fixtures to %s", (version) => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-release-bump-"))
    const writeManifest = (path: string, manifest: object) => {
      const target = join(directory, path)
      mkdirSync(resolve(target, ".."), { recursive: true })
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    const readManifest = (path: string) => JSON.parse(readFileSync(join(directory, path), "utf8"))
    try {
      // uppt has already bumped package versions when the completion step runs.
      writeManifest("package.json", { name: "release-fixture", private: true, version })
      writeManifest("packages/agent/package.json", { name: "@vite-hub/agent", version })
      writeManifest("packages/vite-hub/package.json", { name: "vite-hub", version })
      writeManifest("packages/codemods/package.json", { name: "@vite-hub/codemods", version })
      writeManifest("packages/env/package.json", {
        name: "@vite-hub/env",
        version,
        peerDependencies: { "@vite-hub/agent": "^0.1.0", "vite": "^8.0.0" },
        peerDependenciesMeta: { "@vite-hub/agent": { optional: true }, "vite": { optional: true } },
      })
      writeManifest("packages/peers/package.json", {
        name: "@vite-hub/peers",
        version,
        peerDependencies: { "@vite-hub/agent": "workspace:*", "@vite-hub/env": "~0.1.0", "vite-hub": "0.1.0" },
      })
      const privatePackage = { name: "private", private: true, version: "0.0.0" }
      writeManifest("packages/private/package.json", privatePackage)
      // Resolve the third-party peer locally so the offline check needs no registry metadata.
      writeManifest("packages/vite/package.json", { name: "vite", private: true, version: "8.0.0" })
      const fixtureNames = ["env-schema", "valibot-schema", "zod-schema-module"]
      for (const name of fixtureNames) {
        const path = `packages/codemods/test/fixtures/${name}/output/package.json`
        writeManifest(path, JSON.parse(readFileSync(join(root, path), "utf8")))
      }
      const inputPath = "packages/codemods/test/fixtures/env-schema/input/package.json"
      const input = JSON.parse(readFileSync(join(root, inputPath), "utf8"))
      writeManifest(inputPath, input)

      const bump = () => execFileSync("node", [checker, `release/v${version}`, "--bump"], { cwd: directory, encoding: "utf8" })
      bump()
      expect(readManifest("packages/env/package.json").peerDependencies).toEqual({ "@vite-hub/agent": `^${version}`, "vite": "^8.0.0" })
      expect(readManifest("packages/env/package.json").peerDependenciesMeta["@vite-hub/agent"]).toEqual({ optional: true })
      expect(readManifest("packages/peers/package.json").peerDependencies).toEqual({
        "@vite-hub/agent": "workspace:*",
        "@vite-hub/env": `~${version}`,
        "vite-hub": version,
      })
      for (const name of fixtureNames) {
        const manifest = readManifest(`packages/codemods/test/fixtures/${name}/output/package.json`)
        expect((manifest.dependencies ?? manifest.devDependencies)["vite-hub"]).toBe(`^${version}`)
        if (name === "env-schema") expect(manifest.dependencies["@vite-hub/env"]).toBe(`^${version}`)
      }
      expect(readManifest(inputPath)).toEqual(input)
      expect(readManifest("packages/private/package.json")).toEqual(privatePackage)

      const envPath = join(directory, "packages/env/package.json")
      const firstBump = readFileSync(envPath, "utf8")
      bump()
      expect(readFileSync(envPath, "utf8")).toBe(firstBump)
      execFileSync("node", [checker, `release/v${version}`], { cwd: directory })

      // Prefer the local Vite peer even when the registry cache contains a newer matching release.
      writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\nlinkWorkspacePackages: true\npreferWorkspacePackages: true\n")
      // Select pnpm explicitly without adding it as an offline config dependency.
      execFileSync("corepack", ["pnpm@12.16.1", "install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile", "--offline"], {
        cwd: directory,
        stdio: "pipe",
        env: { ...process.env, CI: "true", COREPACK_ENABLE_AUTO_PIN: "0" },
      })
      // Accept a package-manager document before the project document, too.
      const lockfile = parseAllDocuments(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8")).at(-1)?.toJS()
      expect(lockfile.importers["packages/env"].dependencies["@vite-hub/agent"]).toEqual({ specifier: `^${version}`, version: "link:../agent" })
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("recovers the unpublished version after a correction commit", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-release-recovery-"))
    try {
      mkdirSync(join(directory, "packages", "public"), { recursive: true })
      const writeVersion = (version: string) => {
        writeFileSync(join(directory, "package.json"), JSON.stringify({ version }))
        writeFileSync(join(directory, "packages", "public", "package.json"), JSON.stringify({ name: "public", version }))
      }
      const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
      const commit = (message: string) => {
        git("add", ".")
        git("-c", "user.name=Release Test", "-c", "user.email=release@example.test", "commit", "-qm", message)
      }

      git("init", "-q")
      writeVersion("1.0.0")
      commit("chore: baseline")
      git("tag", "v1.0.0")
      writeVersion("1.1.0")
      commit("feat: merged release candidate")
      const failedSha = git("rev-parse", "HEAD")
      writeFileSync(join(directory, "correction-1.txt"), "first correction\n")
      commit("fix: correct release verification")
      writeFileSync(join(directory, "correction-2.txt"), "second correction\n")
      commit("fix: complete release correction")
      const recoverySha = git("rev-parse", "HEAD")
      writeFileSync(join(directory, "unrelated.txt"), "later change\n")
      commit("chore: unrelated later work")

      expect(git("describe", "--tags", "--abbrev=0")).toBe("v1.0.0")
      expect(git("rev-parse", `${recoverySha}^1`)).not.toBe(failedSha)
      expect(git("rev-list", "--first-parent", `${failedSha}..${recoverySha}`).split("\n")).toHaveLength(2)
      expect(git("rev-parse", "HEAD")).not.toBe(recoverySha)
      git("-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", recoverySha)
      expect(execFileSync("node", [checker, "release/v1.1.0"], { cwd: directory, encoding: "utf8" }))
        .toContain("Validated 1 packages at 1.1.0")
      const recovery = workflow.slice(workflow.indexOf("  recover-release:\n"), workflow.indexOf("  verify-release:\n"))
      expect(recovery).toContain('release_tag="${release_branch#release/}"')
      expect(recovery).toContain('git checkout --detach "$recovery_sha"')
      expect(recovery).toContain('git rev-list --first-parent --reverse "${failed_sha}..${recovery_sha}"')
      expect(recovery).toContain('"repos/${GITHUB_REPOSITORY}/commits/${commit_sha}/pulls"')
      expect(recovery).toContain('-f "ref=refs/tags/${RELEASE_TAG}" -f "sha=${RELEASE_SHA}"')
      expect(recovery).not.toContain('sha=${GITHUB_SHA}')
      expect(recovery).toContain("vp run verify")
      expect(recovery).not.toContain("danielroe/uppt/pr")
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
