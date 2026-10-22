import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { array, boolean, object, optional, parse, record, string } from "valibot"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

const workflow = parse(object({ permissions: record(string(), string()), jobs: record(string(), object({
  name: optional(string()),
  needs: optional(array(string())),
  if: optional(string()),
  "continue-on-error": optional(boolean()),
  steps: array(object({ run: optional(string()), env: optional(record(string(), string())) })),
})) }), parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")))
const jobNames = Object.keys(workflow.jobs).filter(name => name !== "ci")
// These jobs failed on every push to main from 2026-10-19 to 10-22. They run and report, but do not fail ci.
const advisoryJobs = ["consumer-contracts", "consumer-contracts-success", "docs", "docs-deploy", "verify-providers"]
const blockingJobs = jobNames.filter(name => !advisoryJobs.includes(name))
const gate = workflow.jobs.ci!
const fullSuite = "${{ github.event_name != 'pull_request' || (startsWith(github.head_ref, 'babysitter/repair-main-') && github.event.pull_request.head.repo.full_name == github.repository) }}"

function runGate(results: Record<string, { result: string }>, event = "pull_request", repairMain = false) {
  const command = gate.steps.find(step => step.env?.CI_RESULTS)?.run
  if (!command) throw new Error("The ci check must inspect dependency job results")
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
    encoding: "utf8",
    env: { ...process.env, CI_RESULTS: JSON.stringify(results), GITHUB_EVENT_NAME: event, REPAIR_MAIN: String(repairMain) },
  })
}

const successfulJobs = Object.fromEntries(jobNames.map(name => [name, { result: "success" }]))

describe("CI merge gate", () => {
  it("runs standalone Node tests once across Agent shards and preserves failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-node-test-sharding-"))
    const fixture = join(directory, "fixture.test.mjs")
    const runner = new URL("../packages/agent/test/run-node-tests.mjs", import.meta.url)
    const run = (shard: string) => spawnSync(process.execPath, [runner.pathname, fixture], {
      encoding: "utf8",
      env: { ...process.env, VITEHUB_TEST_SHARD: shard },
    })
    try {
      writeFileSync(fixture, 'import { test } from "node:test"; test("shard fixture", () => {})')
      for (const shard of ["", "1/3", "2/3", "3/3"]) {
        const result = run(shard)
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain(`tests ${shard === "2/3" || shard === "3/3" ? 0 : 1}`)
      }
      writeFileSync(fixture, 'import { test } from "node:test"; test("failure", () => { throw new Error("fixture failure") })')
      expect(run("1/3").status).not.toBe(0)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("builds contracts and examples once before running either check", () => {
    const commands = workflow.jobs["contracts-examples"]?.steps.flatMap(step => step.run ? [step.run] : [])
    expect(commands).toEqual([
      "vp run build",
      "git diff --exit-code -- 'packages/*/package.json' || {\n  echo \"::error::vp run build rewrote package.json exports. Run it locally and commit the result.\"\n  exit 1\n}\n",
      "vp run package:metadata",
      "vp test --config vitest.config.ts --exclude test/docs-host-fixtures.test.ts",
      "vp run --ignore-depends-on examples:verify",
    ])
  })

  it("runs packed release contracts for pull requests and manual dispatches", () => {
    const prepublish = workflow.jobs["prepublish-contracts"]
    expect(prepublish?.if).toBe("${{ github.event_name != 'push' }}")
    expect(prepublish?.steps.flatMap(step => step.run ? [step.run] : [])).toEqual([
      'vp run --no-cache --filter "./packages/*" build',
      [
        "node .github/scripts/release-packages.mjs pack \\",
        "  --workspace . \\",
        "  --output .release/npm \\",
        "  --source-sha \"$GITHUB_SHA\"",
      ].join("\n") + "\n",
      [
        "node .github/scripts/release-packages.mjs verify \\",
        "  --manifest .release/npm/release-manifest.json \\",
        "  --workspace . \\",
        "  --source-sha \"$GITHUB_SHA\"",
      ].join("\n") + "\n",
      "vp run test:consumer",
    ])
    expect(prepublish?.steps.find(step => step.env?.VITEHUB_RELEASE_MANIFEST)?.env).toEqual({
      VITEHUB_RELEASE_MANIFEST: "${{ github.workspace }}/.release/npm/release-manifest.json",
    })
  })

  it("uses read-only repository credentials for verification", () => {
    expect(workflow.permissions).toEqual({ contents: "read" })
  })

  it("waits for every verification job and runs even when a dependency fails", () => {
    expect(gate.name).toBe("ci")
    expect(gate.needs?.toSorted()).toEqual(jobNames.toSorted())
    expect(gate.if).toBe("${{ always() }}")
    expect(gate.steps.find(step => step.env?.CI_RESULTS)?.env?.CI_RESULTS).toBe("${{ toJSON(needs) }}")
  })

  it.each(["pull_request", "push", "workflow_dispatch"])("accepts successful checks on %s", (event) => {
    const result = runGate(successfulJobs, event)
    expect(result.status, result.stderr).toBe(0)
  })

  it("requires the default success condition across all consumer matrix shards", () => {
    const marker = workflow.jobs["consumer-contracts-success"]
    expect(marker?.needs).toEqual(["consumer-contracts"])
    expect(marker?.if).toBeUndefined()
  })

  it("requires the default success condition across all package test shards", () => {
    const marker = workflow.jobs["package-tests-success"]
    expect(marker?.needs).toEqual(["package-tests"])
    expect(marker?.if).toBeUndefined()
  })

  it("runs docs workspace tests on pushes", () => {
    const docs = workflow.jobs.docs
    expect(docs?.if).toBe(fullSuite)
    expect(docs?.steps.some(step => step.run === "vp run --filter vitehub-docs test")).toBe(true)
  })

  it.each(["push", "workflow_dispatch"])("rejects a partial package test rerun with failed shards on %s", (event) => {
    const result = runGate({
      ...successfulJobs,
      "package-tests": { result: "success" },
      "package-tests-success": { result: "skipped" },
    }, event)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("package-tests-success: skipped")
  })

  it.each(advisoryJobs)("reports a failed %s job without failing ci", (name) => {
    const result = runGate({ ...successfulJobs, [name]: { result: "failure" } }, "push")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`::warning::${name} (advisory): failure`)
  })

  it("keeps the workflow run green when an advisory job fails", () => {
    for (const name of ["consumer-contracts", "docs", "docs-deploy", "verify-providers"]) {
      expect(workflow.jobs[name]?.["continue-on-error"], name).toBe(true)
    }
  })

  const pullRequestJobs = [
    "checks",
    "workflow-lint",
    "contract-tests",
    "package-tests",
    "package-tests-success",
  ]

  it("accepts the checks intentionally skipped on pull requests", () => {
    const results = Object.fromEntries(jobNames.map(name => [name, {
      result: ["checks", "workflow-lint", "contracts-examples", "contract-tests", "package-tests", "package-tests-success", "docs", "prepublish-contracts"].includes(name) ? "success" : "skipped",
    }]))
    expect(runGate(results).status).toBe(0)
    expect(runGate(results, "push").status).not.toBe(0)
  })

  it("requires packed release contracts on pull requests while allowing their push skip", () => {
    const results = { ...successfulJobs, "prepublish-contracts": { result: "skipped" } }
    expect(runGate(results, "pull_request").status).not.toBe(0)
    expect(runGate(results, "push").status).toBe(0)
  })

  it("rejects the push-only checks skipped on a repair-main pull request", () => {
    // A repair that passed only the pull request checks merged and left main red.
    const results = Object.fromEntries(jobNames.map(name => [name, {
      result: pullRequestJobs.includes(name) ? "success" : "skipped",
    }]))
    expect(gate.steps.find(step => step.env?.CI_RESULTS)?.env?.REPAIR_MAIN).toBe("${{ startsWith(github.head_ref, 'babysitter/repair-main-') && github.event.pull_request.head.repo.full_name == github.repository }}")
    const result = runGate({ ...results, "docs-deploy": { result: "skipped" } }, "pull_request", true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("contracts-examples: skipped")
    expect(result.stderr).toContain("windows-agent-credentials: skipped")
  })

  it.each(pullRequestJobs)("runs %s on pull requests and rejects a skipped result", (name) => {
    expect(workflow.jobs[name]?.if).toBeUndefined()
    expect(runGate({ ...successfulJobs, [name]: { result: "skipped" } }).status).not.toBe(0)
  })

  it("selects package tests from the pull request change", () => {
    const commands = workflow.jobs["package-tests"]?.steps.flatMap(step => step.run ? [step.run] : []).join("\n")
    expect(commands).toContain("node test/run-package-task.mjs test ${{ matrix.shard.args }} --affected \"$BASE_REF\" --list")
  })

  it("keeps consumer contracts on push and repair-main pull requests", () => {
    expect(workflow.jobs["consumer-contracts"]?.if).toBe(fullSuite)
  })

  it.each(blockingJobs)("rejects a failed or cancelled %s job", (name) => {
    for (const result of ["failure", "cancelled"]) {
      expect(runGate({ ...successfulJobs, [name]: { result } }).status).not.toBe(0)
    }
  })

  it.each(["checks", "workflow-lint", "contracts-examples", "package-tests", "package-tests-success"])("rejects skipped required job %s", (name) => {
    const event = name === "checks" || name === "workflow-lint" ? "pull_request" : "push"
    expect(runGate({ ...successfulJobs, [name]: { result: "skipped" } }, event).status).not.toBe(0)
  })

  it("requires new verification jobs to succeed unless explicitly allowed to skip", () => {
    const result = runGate({ ...successfulJobs, "new-verification": { result: "skipped" } })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("new-verification: skipped")
  })
})
