import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

import { describe, expect, it } from "vitest"
import { isMap, isSeq, parseDocument } from "yaml"

const root = resolve(import.meta.dirname, "..")
const workflow = readFileSync(resolve(root, ".github/workflows/release-pr.yml"), "utf8")
const checker = resolve(root, ".github/scripts/check-release-candidate.mjs")

describe("release PR workflow", () => {
  it("gates tag creation on the merged commit's full verification", () => {
    expect(workflow).toMatch(/uses: danielroe\/uppt\/pr@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/)
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
    expect(workflow).toContain("for workflow in ci.yml; do")
    expect(workflow).toContain('gh workflow run "$workflow" --repo "$GITHUB_REPOSITORY" --ref "$release_branch"')
    expect(workflow).toContain("actions: write")
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository")
    expect(workflow).toContain("ref: ${{ github.event.pull_request.merge_commit_sha }}")
    expect(workflow).toContain("uses: ./.github/actions/verify-release")
    expect(workflow).toContain("needs: verify-release")
    expect(workflow).toContain("if: needs.verify-release.result == 'success'")
    expect(workflow).toContain('existing_sha" != "$RELEASE_SHA')
    expect(workflow).toContain('gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref "$release_tag"')
    expect(workflow).toContain('gh workflow run release-pr.yml --repo "$GITHUB_REPOSITORY" --ref main')
    expect(workflow).not.toContain("pull_request_target")
  })

  it("checks uppt's release commit and dispatches checks without adding a commit", () => {
    const check = workflow.indexOf('node "$GITHUB_WORKSPACE/.github/scripts/check-release-candidate.mjs" "$release_branch"\n')
    const head = workflow.indexOf('head_sha="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/${release_branch}"')
    const dispatch = workflow.indexOf('gh workflow run "$workflow"')
    expect(check).toBeGreaterThan(-1)
    expect(head).toBeGreaterThan(check)
    expect(dispatch).toBeGreaterThan(head)
    expect(workflow).not.toContain("--bump")
    expect(workflow).not.toContain("git commit")
    expect(workflow).not.toContain("commit -m")
    expect(workflow).not.toContain("push origin")
    expect(workflow).not.toContain("--lockfile-only")
  })

  const fullRun = { id: 42, head_sha: "candidate-sha", event: "workflow_dispatch", status: "completed", conclusion: "success" }
  it.each([
    ...["requested", "queued", "pending", "waiting", "in_progress"].map(status => ({
      scenario: `${status} full run`, runs: [{ ...fullRun, status, conclusion: null }], dispatch: false,
    })),
    { scenario: "successful full run", runs: [fullRun], dispatch: false },
    { scenario: "failed full run", runs: [{ ...fullRun, conclusion: "failure" }], dispatch: true },
    { scenario: "cancelled full run", runs: [{ ...fullRun, conclusion: "cancelled" }], dispatch: true },
    { scenario: "successful lightweight PR run", runs: [{ ...fullRun, event: "pull_request" }], dispatch: true },
    { scenario: "successful full run for an older SHA", runs: [{ ...fullRun, head_sha: "older-sha" }], dispatch: true },
    { scenario: "empty run history", runs: [], dispatch: true },
  ])("decides whether to dispatch CI with $scenario", ({ runs, dispatch }) => {
    const steps = parseDocument(workflow).getIn(["jobs", "proposal", "steps"], true)
    if (!isSeq(steps)) throw new Error("Missing release proposal steps")
    const step = steps.items.find(item => isMap(item) && item.get("name") === "Check the release PR and run required checks")
    const script = isMap(step) ? step.get("run") : undefined
    if (typeof script !== "string") throw new TypeError("Missing release proposal check script")

    const directory = mkdtempSync(join(tmpdir(), "vitehub-release-ci-"))
    try {
      const output = execFileSync("bash", ["--noprofile", "--norc", "-c", `
        git() { :; }
        node() { :; }
        gh() {
          case "$1:$2" in
            api:*/pulls*) echo release/v0.5.0 ;;
            api:*/git/ref/heads/*) echo candidate-sha ;;
            api:*/actions/workflows/ci.yml/runs*)
              jq --arg query "\${2#*\\?}" '
                ($query | split("&") | map(split("=") | {key: .[0], value: .[1]}) | from_entries) as $filters
                | .workflow_runs |= map(select(.head_sha == $filters.head_sha and ($filters.event == null or .event == $filters.event)))
              ' <<< "$WORKFLOW_RUNS" | jq -r "$4"
              ;;
            workflow:run) printf 'dispatch %s\\n' "\${*:3}" ;;
            *) return 1 ;;
          esac
        }
        ${script}
      `], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "vite-hub/vitehub",
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: directory,
          WORKFLOW_RUNS: JSON.stringify({ workflow_runs: runs }),
        },
      })
      expect(output.split("\n").filter(line => line.startsWith("dispatch ")))
        .toEqual(dispatch ? ["dispatch ci.yml --repo vite-hub/vitehub --ref release/v0.5.0"] : [])
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects a branch or package version mismatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-release-pr-"))
    try {
      mkdirSync(join(directory, "packages", "public"), { recursive: true })
      mkdirSync(join(directory, "packages", "private"))
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.1.0" }))
      writeFileSync(join(directory, "packages", "public", "package.json"), JSON.stringify({ name: "public", version: "0.1.0" }))
      writeFileSync(join(directory, "packages", "private", "package.json"), JSON.stringify({ name: "private", version: "0.0.1", private: true }))
      writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")

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

  it("passes on this repository at its current version", () => {
    const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
    expect(execFileSync("node", [checker, `release/v${version}`], { cwd: root, encoding: "utf8" })).toContain(`at ${version}`)
  })

  it.each(["0.2.0", "0.2.1", "1.0.0-rc.1"])("needs only uppt's version commit to release %s", (version) => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-release-bump-"))
    const writeManifest = (path: string, manifest: object) => {
      const target = join(directory, path)
      mkdirSync(resolve(target, ".."), { recursive: true })
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    const workspace = (current: string, envAgentRange: string) => {
      writeManifest("package.json", { name: "release-fixture", private: true, version: current })
      writeManifest("packages/agent/package.json", { name: "@vite-hub/agent", version: current, dependencies: { "@vite-hub/env": "workspace:*" } })
      writeManifest("packages/env/package.json", {
        name: "@vite-hub/env",
        version: current,
        peerDependencies: { "@vite-hub/agent": envAgentRange },
        peerDependenciesMeta: { "@vite-hub/agent": { optional: true } },
      })
      writeManifest("packages/peers/package.json", { name: "@vite-hub/peers", version: current, peerDependencies: { "@vite-hub/env": "workspace:^" } })
      writeManifest("playground/app/package.json", { name: "app", private: true, dependencies: { "@vite-hub/peers": "workspace:*" } })
    }
    const pnpm = (...args: string[]) => execFileSync("corepack", ["pnpm@12.16.1", ...args, "--ignore-scripts", "--offline"], {
      cwd: directory,
      stdio: "pipe",
      env: { ...process.env, CI: "true", COREPACK_ENABLE_AUTO_PIN: "0" },
    })
    const check = () => execFileSync("node", [checker, `release/v${version}`], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    try {
      writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - \"playground/*\"\nlinkWorkspacePackages: true\n")
      workspace("0.1.0", "*")
      pnpm("install", "--lockfile-only", "--no-frozen-lockfile")
      const lockfile = readFileSync(join(directory, "pnpm-lock.yaml"), "utf8")

      workspace(version, "*")
      expect(check()).toContain(`Validated 3 packages at ${version}`)
      pnpm("install", "--lockfile-only", "--frozen-lockfile")
      expect(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8")).toBe(lockfile)

      workspace(version, "^0.1.0")
      expect(() => check()).toThrow("packages/env/package.json peerDependencies @vite-hub/agent is ^0.1.0")
      workspace(version, "*")
      writeManifest("playground/app/package.json", { name: "app", private: true, dependencies: { "@vite-hub/peers": version } })
      expect(() => check()).toThrow(`playground/app/package.json dependencies @vite-hub/peers is ${version}`)
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
      writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
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
      const recovery = workflow.slice(workflow.indexOf("  resolve-recovery:\n"), workflow.indexOf("  verify-release:\n"))
      expect(recovery).toContain('release_tag="${release_branch#release/}"')
      expect(recovery).toContain('git checkout --detach "$recovery_sha"')
      expect(recovery).toContain('git rev-list --first-parent --reverse "${failed_sha}..${recovery_sha}"')
      expect(recovery).toContain('"repos/${GITHUB_REPOSITORY}/commits/${commit_sha}/pulls"')
      expect(recovery).toContain('-f "ref=refs/tags/${RELEASE_TAG}" -f "sha=${RELEASE_SHA}"')
      expect(recovery).not.toContain('sha=${GITHUB_SHA}')
      expect(recovery).toContain("uses: ./.github/actions/verify-release")
      expect(recovery).not.toContain("danielroe/uppt/pr")
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
