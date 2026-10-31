import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { array, boolean, object, optional, parse, pipe, record, string, transform, union } from "valibot"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

const workflowSchema = object({ permissions: record(string(), string()), jobs: record(string(), object({
  name: optional(string()),
  permissions: optional(record(string(), string())),
  needs: optional(pipe(union([string(), array(string())]), transform(value => typeof value === "string" ? [value] : value))),
  if: optional(string()),
  "continue-on-error": optional(boolean()),
  steps: array(object({ run: optional(string()), env: optional(record(string(), string())) })),
})) })
const workflow = parse(workflowSchema, parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")))
const jobNames = Object.keys(workflow.jobs).filter(name => name !== "ci")
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

  it("builds example dependencies once before checking metadata and examples", () => {
    const commands = workflow.jobs["contracts-examples"]?.steps.flatMap(step => step.run ? [step.run] : [])
    expect(commands).toEqual([
      "vp run build",
      "git diff --exit-code -- 'packages/*/package.json' || {\n  echo \"::error::vp run build rewrote package.json exports. Run it locally and commit the result.\"\n  exit 1\n}\n",
      "vp run package:metadata",
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

  it("runs docs verification on pull requests before changes can reach production", () => {
    const docs = workflow.jobs.docs
    expect(docs?.if).toBeUndefined()
    expect(docs?.["continue-on-error"]).not.toBe(true)
    expect(docs?.steps.some(step => step.run === "vp run --filter vitehub-docs test")).toBe(true)
  })

  it("requires successful docs verification and deployment on pushes", () => {
    expect(workflow.jobs["docs-deploy"]?.["continue-on-error"]).not.toBe(true)
    expect(workflow.jobs["docs-deploy"]?.needs?.toSorted()).toEqual(jobNames.filter(name => !["docs-deploy", "prepublish-contracts", "package-tests", "consumer-contracts"].includes(name)).toSorted())
    for (const name of ["docs", "docs-deploy"]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        const run = runGate({ ...successfulJobs, [name]: { result } }, "push")
        expect(run.status, `${name}: ${result}`).not.toBe(0)
        expect(run.stderr).toContain(`${name}: ${result}`)
      }
    }
    expect(runGate({ ...successfulJobs, "docs-deploy": { result: "skipped" } }).status).toBe(0)
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

  it("rejects a partial consumer test rerun with a failed matrix shard", () => {
    const result = runGate({
      ...successfulJobs,
      "consumer-contracts": { result: "success" },
      "consumer-contracts-success": { result: "skipped" },
    }, "push")
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("consumer-contracts-success: skipped")
  })

  it.each(jobNames)("keeps failures from %s blocking", (name) => {
    expect(workflow.jobs[name]?.["continue-on-error"]).not.toBe(true)
  })

  const pullRequestJobs = [
    "checks",
    "workflow-lint",
    "contract-tests",
    "package-tests",
    "package-tests-success",
    "docs",
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

  it.each(jobNames)("rejects a failed or cancelled %s job", (name) => {
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

describe("live smoke deployment gate", () => {
  const liveSmoke = parse(workflowSchema, parseYaml(readFileSync(new URL("../.github/workflows/live-smoke.yml", import.meta.url), "utf8")))

  it("checks CI for the exact main commit before building and deploying", () => {
    const setup = liveSmoke.jobs["setup-cloudflare"]
    expect(setup?.permissions).toEqual({ actions: "read", contents: "read" })
    expect(liveSmoke.jobs["live-smoke"]?.needs).toEqual(["setup-cloudflare"])
    const commands = setup?.steps.flatMap(step => step.run ? [step.run] : []) ?? []
    const command = commands[0]
    if (!command) throw new Error("Live smoke must check CI before building")
    expect(command).toContain('actions/workflows/ci.yml/runs')
    expect(command).toContain('-f head_sha="$GITHUB_SHA" -f branch=main -f event=push')
    const directory = mkdtempSync(join(tmpdir(), "vitehub-live-ci-gate-"))
    try {
      writeFileSync(join(directory, "gh"), '#!/bin/sh\nprintf "%s\\n" "$CI_CONCLUSION"\nexit "$API_STATUS"\n', { mode: 0o755 })
      for (const conclusion of ["success", "failure", "cancelled", "missing"]) {
        const result = spawnSync("bash", ["-eo", "pipefail", "-c", command], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CI_CONCLUSION: conclusion, API_STATUS: "0", GITHUB_SHA: "verified-main", GITHUB_REPOSITORY: "vite-hub/vitehub" },
        })
        expect(result.status === 0, result.stdout + result.stderr).toBe(conclusion === "success")
      }
      const unavailable = spawnSync("bash", ["-eo", "pipefail", "-c", command], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CI_CONCLUSION: "success", API_STATUS: "1" },
      })
      expect(unavailable.status).not.toBe(0)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
