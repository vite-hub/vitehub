import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { parse } from "yaml"

import viteConfig from "../vite.config.ts"

interface Step {
  env?: Record<string, string>
  id?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string>
}

interface Job {
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  steps: Step[]
}

interface Workflow {
  jobs: Record<string, Job>
}

interface Action {
  outputs: Record<string, { value: string }>
  runs: { steps: Step[], using: string }
}

const root = resolve(import.meta.dirname, "..")
const verifierPath = "./.github/actions/verify-release"
const verifier: Action = parse(readFileSync(resolve(root, ".github/actions/verify-release/action.yml"), "utf8"))
const release: Workflow = parse(readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8"))
const releasePr: Workflow = parse(readFileSync(resolve(root, ".github/workflows/release-pr.yml"), "utf8"))
const fullSha = "a".repeat(40)
const otherSha = "b".repeat(40)

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "vitehub-release-verification-"))
  directories.push(directory)
  return directory
}

function step(steps: Step[], name: string) {
  const found = steps.find(candidate => candidate.name === name)
  if (!found?.run) throw new Error(`Missing step: ${name}`)
  return found.run
}

function verifierStep(job: Job) {
  const steps = job.steps.filter(candidate => candidate.uses === verifierPath)
  expect(steps).toHaveLength(1)
  return steps[0]!
}

function runScript(script: string, options: { cwd: string, env: Record<string, string> }) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  })
}

function outputs(path: string) {
  return Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map(line => line.split("=", 2)))
}

function runTagScriptWithStubbedGitHub(script: string, env: Record<string, string>) {
  const directory = temporaryDirectory()
  const log = join(directory, "calls.log")
  writeFileSync(log, "")
  const result = runScript(`
    gh() {
      printf 'gh %s\\n' "$*" >> "$CALL_LOG"
      case "$*" in
        *"/compare/"*) echo ahead ;;
        "api repos/vite-hub/vitehub/commits/v"*) return 1 ;;
      esac
    }
    bash() { :; }
    ${script}
  `, { cwd: directory, env: { CALL_LOG: log, GITHUB_REPOSITORY: "vite-hub/vitehub", ...env } })
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
  return { calls, status: result.status, stderr: result.stderr }
}

describe("release verification before tagging", () => {
  const preTagJobs = [
    {
      name: "verify-release",
      job: releasePr.jobs["verify-release"]!,
      sha: "${{ github.event.pull_request.merge_commit_sha }}",
      version: "${{ steps.release.outputs.version }}",
    },
    {
      name: "verify-recovery",
      job: releasePr.jobs["verify-recovery"]!,
      sha: "${{ needs.resolve-recovery.outputs.sha }}",
      version: "${{ needs.resolve-recovery.outputs.version }}",
    },
  ]

  it.each(preTagJobs)("$name runs the shared verifier on the exact commit and version", ({ job, sha, version }) => {
    const checkout = job.steps.find(candidate => candidate.uses?.startsWith("actions/checkout@"))
    expect(checkout?.with?.ref).toBe(sha)
    expect(verifierStep(job).with).toEqual({ exact: "true", "source-sha": sha, version })
    expect(job.outputs).toEqual({
      sha: "${{ steps.verified.outputs.sha }}",
      version: "${{ steps.verified.outputs.version }}",
    })
    expect(job.permissions).toEqual({ contents: "read" })
  })

  it("derives the normal release version from the merged release branch", () => {
    const directory = temporaryDirectory()
    const output = join(directory, "output")
    const script = step(releasePr.jobs["verify-release"]!.steps, "Resolve the release version")
    expect(runScript(script, { cwd: directory, env: { GITHUB_OUTPUT: output, RELEASE_BRANCH: "release/v0.5.0" } }).status).toBe(0)
    expect(outputs(output)).toEqual({ version: "0.5.0" })
  })

  it("release.yml runs the same verifier, exact for a tag and synthetic for a branch", () => {
    const job = release.jobs.verify!
    expect(job.steps.find(candidate => candidate.uses?.startsWith("actions/checkout@"))?.with?.ref).toBeUndefined()
    expect(verifierStep(job).with).toEqual({
      exact: "${{ steps.release.outputs.publish }}",
      "source-sha": "${{ github.sha }}",
      version: "${{ steps.release.outputs.version }}",
    })
    expect(job.outputs).toMatchObject({
      npm_tag: "${{ steps.verified.outputs.npm-tag }}",
      prerelease: "${{ steps.verified.outputs.prerelease }}",
      version: "${{ steps.verified.outputs.version }}",
    })
  })

  it("keeps the release checks in one implementation", () => {
    for (const workflow of [release, releasePr]) {
      for (const job of Object.values(workflow.jobs)) {
        for (const { run = "" } of job.steps) {
          expect(run).not.toContain("vp run verify")
          expect(run).not.toContain("release-packages.mjs pack")
          expect(run).not.toContain("--dry-run")
        }
      }
    }
  })

  it("creates tags only in jobs that need a successful verification", () => {
    const tagging = Object.entries(releasePr.jobs)
      .filter(([, job]) => job.steps.some(candidate => candidate.run?.includes("/git/refs")))
      .map(([name]) => name)
    expect(tagging.sort()).toEqual(["recover-release", "tag-release"])

    const normal = releasePr.jobs["tag-release"]!
    expect(normal.needs).toBe("verify-release")
    expect(normal.if).toBe("needs.verify-release.result == 'success'")
    expect(normal.permissions).toEqual({ actions: "write", contents: "write" })

    const recovery = releasePr.jobs["recover-release"]!
    expect(recovery.needs).toEqual(["resolve-recovery", "verify-recovery"])
    expect(recovery.if).toBe("needs.verify-recovery.result == 'success'")
    expect(recovery.permissions).toEqual({ actions: "write", contents: "write" })
    expect(recovery.steps.every(candidate => !candidate.uses)).toBe(true)
    expect(releasePr.jobs["verify-recovery"]!.needs).toBe("resolve-recovery")
    expect(releasePr.jobs["resolve-recovery"]!.permissions).toEqual({ contents: "read", "pull-requests": "read" })
  })

  describe("normal tag", () => {
    const job = releasePr.jobs["tag-release"]!
    const script = step(job.steps, "Create tag and dispatch verified release")
    const env = {
      RELEASE_BRANCH: "release/v0.5.0",
      RELEASE_SHA: fullSha,
      VERIFIED_SHA: fullSha,
      VERIFIED_VERSION: "0.5.0",
    }

    it("reads the verified commit and version from the verify job", () => {
      expect(job.steps.find(candidate => candidate.name === "Create tag and dispatch verified release")?.env).toMatchObject({
        RELEASE_SHA: "${{ github.event.pull_request.merge_commit_sha }}",
        VERIFIED_SHA: "${{ needs.verify-release.outputs.sha }}",
        VERIFIED_VERSION: "${{ needs.verify-release.outputs.version }}",
      })
    })

    it("tags the verified commit", () => {
      const { calls, status } = runTagScriptWithStubbedGitHub(script, env)
      expect(status).toBe(0)
      expect(calls).toContain(`gh api -X POST repos/vite-hub/vitehub/git/refs -f ref=refs/tags/v0.5.0 -f sha=${fullSha}`)
      expect(calls).toContain("gh workflow run release.yml --repo vite-hub/vitehub --ref v0.5.0")
    })

    it.each([
      { scenario: "another commit", change: { VERIFIED_SHA: otherSha } },
      { scenario: "another version", change: { VERIFIED_VERSION: "0.5.1" } },
      { scenario: "a synthetic version", change: { VERIFIED_VERSION: "0.0.0-dev.42" } },
      { scenario: "no verification", change: { VERIFIED_SHA: "", VERIFIED_VERSION: "" } },
    ])("refuses to tag after verifying $scenario", ({ change }) => {
      const { calls, status, stderr } = runTagScriptWithStubbedGitHub(script, { ...env, ...change })
      expect(status).not.toBe(0)
      expect(stderr).toContain("Release verification passed for")
      expect(calls).toEqual([])
    })
  })

  describe("recovery tag", () => {
    const job = releasePr.jobs["recover-release"]!
    const script = step(job.steps, "Tag corrected main and dispatch release")
    const env = {
      RELEASE_SHA: fullSha,
      RELEASE_TAG: "v0.5.0",
      RELEASE_VERSION: "0.5.0",
      VERIFIED_SHA: fullSha,
      VERIFIED_VERSION: "0.5.0",
    }

    it("reads the reviewed and verified commits from separate jobs", () => {
      expect(job.steps[0]?.env).toMatchObject({
        RELEASE_SHA: "${{ needs.resolve-recovery.outputs.sha }}",
        RELEASE_TAG: "${{ needs.resolve-recovery.outputs.tag }}",
        RELEASE_VERSION: "${{ needs.resolve-recovery.outputs.version }}",
        VERIFIED_SHA: "${{ needs.verify-recovery.outputs.sha }}",
        VERIFIED_VERSION: "${{ needs.verify-recovery.outputs.version }}",
      })
      const resolveScript = step(releasePr.jobs["resolve-recovery"]!.steps, "Resolve reviewed correction boundary")
      expect(resolveScript).toContain('echo "sha=$recovery_sha"')
      expect(resolveScript).toContain('echo "version=${release_tag#v}"')
    })

    it("tags the reviewed commit after it passed verification", () => {
      const { calls, status } = runTagScriptWithStubbedGitHub(script, env)
      expect(status).toBe(0)
      expect(calls).toContain(`gh api -X POST repos/vite-hub/vitehub/git/refs -f ref=refs/tags/v0.5.0 -f sha=${fullSha}`)
      expect(calls).toContain("gh workflow run release.yml --repo vite-hub/vitehub --ref v0.5.0")
    })

    it.each([
      { scenario: "another commit", change: { VERIFIED_SHA: otherSha } },
      { scenario: "another version", change: { VERIFIED_VERSION: "0.5.1" } },
      { scenario: "no verification", change: { VERIFIED_SHA: "", VERIFIED_VERSION: "" } },
      { scenario: "a tag for another version", change: { RELEASE_TAG: "v0.5.1" } },
    ])("refuses to tag after verifying $scenario", ({ change }) => {
      const { calls, status, stderr } = runTagScriptWithStubbedGitHub(script, { ...env, ...change })
      expect(status).not.toBe(0)
      expect(stderr).toContain("Release verification passed for")
      expect(calls).toEqual([])
    })
  })
})

describe("shared release verifier", () => {
  const steps = verifier.runs.steps
  const resolveScript = step(steps, "Resolve the commit and version to verify")
  const applyScript = step(steps, "Apply release version")

  function resolveVersion(env: Record<string, string>) {
    const directory = temporaryDirectory()
    execFileSync("git", ["init", "-q"], { cwd: directory })
    execFileSync("git", ["-c", "user.name=Release Test", "-c", "user.email=release@example.test", "commit", "-q", "--allow-empty", "-m", "release"], { cwd: directory })
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim()
    const output = join(directory, "output")
    const result = runScript(resolveScript, {
      cwd: directory,
      env: { GITHUB_OUTPUT: output, RELEASE_EXACT: "true", RELEASE_SHA: head, ...env },
    })
    return { head, output: result.status === 0 ? outputs(output) : undefined, result }
  }

  it("is a composite action whose outputs come from the checked commit", () => {
    expect(verifier.runs.using).toBe("composite")
    for (const name of ["npm-tag", "prerelease", "sha", "version"]) {
      expect(verifier.outputs[name]?.value).toBe(`\${{ steps.version.outputs.${name} }}`)
    }
  })

  it.each([
    ["1.2.3", "latest", "false"],
    ["1.2.3-alpha.1", "alpha", "true"],
    ["1.2.3-beta.1", "beta", "true"],
    ["1.2.3-rc.1", "rc", "true"],
    ["0.0.0-dev.42", "next", "true"],
  ])("verifies %s at the checked-out commit with npm tag %s", (version, npmTag, prerelease) => {
    const { head, output } = resolveVersion({ RELEASE_VERSION: version })
    expect(output).toEqual({ "npm-tag": npmTag, prerelease, sha: head, version })
  })

  it.each<{ env: Record<string, string>, error: string, scenario: string }>([
    { scenario: "another commit", env: { RELEASE_SHA: otherSha, RELEASE_VERSION: "1.2.3" }, error: "not the release commit" },
    { scenario: "a short SHA", env: { RELEASE_SHA: "abc123", RELEASE_VERSION: "1.2.3" }, error: "Invalid release commit" },
    { scenario: "a tag name", env: { RELEASE_VERSION: "v1.2.3" }, error: "Invalid release version" },
    { scenario: "an empty version", env: { RELEASE_VERSION: "" }, error: "Invalid release version" },
    { scenario: "an unknown mode", env: { RELEASE_EXACT: "yes", RELEASE_VERSION: "1.2.3" }, error: "exact must be true or false" },
  ])("rejects $scenario", ({ env, error }) => {
    const { result } = resolveVersion(env)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(error)
  })

  function workspace(rootVersion: string, packageVersion: string) {
    const directory = temporaryDirectory()
    const write = (path: string, manifest: object) => {
      mkdirSync(resolve(directory, path, ".."), { recursive: true })
      writeFileSync(join(directory, path), `${JSON.stringify(manifest, null, 2)}\n`)
    }
    write("package.json", { private: true, version: rootVersion })
    write("packages/public/package.json", { name: "@vite-hub/public", version: packageVersion })
    write("packages/private/package.json", { name: "private", private: true, version: "0.0.1" })
    const read = (path: string) => JSON.parse(readFileSync(join(directory, path), "utf8")).version
    return { directory, read }
  }

  it("requires every publishable manifest to match an exact version", () => {
    const exact = workspace("0.5.0", "0.5.0")
    expect(runScript(applyScript, { cwd: exact.directory, env: { RELEASE_EXACT: "true", RELEASE_VERSION: "0.5.0" } }).status).toBe(0)
    expect(exact.read("packages/public/package.json")).toBe("0.5.0")

    const packageBehind = workspace("0.5.0", "0.4.0")
    const result = runScript(applyScript, { cwd: packageBehind.directory, env: { RELEASE_EXACT: "true", RELEASE_VERSION: "0.5.0" } })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("does not match @vite-hub/public version 0.4.0")

    const rootBehind = workspace("0.4.0", "0.5.0")
    expect(runScript(applyScript, { cwd: rootBehind.directory, env: { RELEASE_EXACT: "true", RELEASE_VERSION: "0.5.0" } }).stderr)
      .toContain("does not match root version 0.4.0")
  })

  it("restores checked-in versions before the branch dry run checks source manifests", () => {
    const branch = workspace("0.5.0", "0.5.0")
    const env = { RELEASE_EXACT: "false", RELEASE_VERSION: "0.0.0-dev.42" }
    const options = { cwd: branch.directory, env }
    expect(runScript(applyScript, options).status).toBe(0)
    expect(branch.read("packages/public/package.json")).toBe("0.0.0-dev.42")
    expect(branch.read("packages/private/package.json")).toBe("0.0.1")
    expect(runScript(step(steps, "Pin release dependency versions"), options).status).toBe(0)
    expect(branch.read("packages/public/package.json")).toBe("0.0.0-dev.42")
    expect(runScript(step(steps, "Restore checked-in manifests"), options).status).toBe(0)
    expect(branch.read("packages/public/package.json")).toBe("0.5.0")
  })

  it("runs every check in order and publishes only as a dry run", () => {
    const order = [
      (candidate: Step) => candidate.id === "version",
      (candidate: Step) => candidate.uses === "./.github/actions/setup",
      (candidate: Step) => candidate.uses === "./.github/actions/setup-deno",
      (candidate: Step) => candidate.run === "vp run verify:source",
      (candidate: Step) => candidate.name === "Apply release version",
      (candidate: Step) => candidate.run === 'vp run --no-cache --filter "./packages/*" build',
      (candidate: Step) => candidate.name === "Pin release dependency versions",
      (candidate: Step) => candidate.run?.includes("release-packages.mjs pack") && candidate.run.includes("--verify-reproducible"),
      (candidate: Step) => candidate.name === "Restore checked-in manifests",
      (candidate: Step) => candidate.run?.includes("release-packages.mjs verify") && candidate.run.includes("publint run"),
      (candidate: Step) => candidate.run === "vp run test:contracts" && Boolean(candidate.env?.VITEHUB_RELEASE_MANIFEST),
      (candidate: Step) => candidate.run === "vp run test:consumer" && Boolean(candidate.env?.VITEHUB_RELEASE_MANIFEST),
      (candidate: Step) => candidate.run?.includes("release-packages.mjs publish") && candidate.run.includes("--dry-run"),
    ]
    expect(steps.map(candidate => order.findIndex(matches => matches(candidate)))).toEqual(order.map((_, index) => index))

    for (const { env = {}, run = "" } of steps) {
      expect(run).not.toContain("${{")
      expect(run).not.toContain("GITHUB_SHA")
      if (run.includes("--source-sha")) expect(env.RELEASE_SHA).toBe("${{ inputs.source-sha }}")
    }
  })

  it("runs the same source checks as the local verify gate", () => {
    const tasks = viteConfig.run?.tasks
    expect(tasks?.verify).toEqual({
      cache: false,
      command: "vp run verify:source && vp run test:contracts && vp run test:consumer",
    })
    expect(tasks?.["verify:source"]).toEqual({
      cache: false,
      command: "vp run preflight && vp run knip:catalog && vp run lint && vp run doctor:typescript && vp run typecheck && vp run package:metadata && vp run test",
    })
  })
})
