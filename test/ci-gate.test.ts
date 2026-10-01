import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { array, object, optional, parse, record, string } from "valibot"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

const workflow = parse(object({ permissions: record(string(), string()), jobs: record(string(), object({
  name: optional(string()),
  needs: optional(array(string())),
  if: optional(string()),
  steps: array(object({ run: optional(string()), env: optional(record(string(), string())) })),
})) }), parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")))
const jobNames = Object.keys(workflow.jobs).filter(name => name !== "ci")
const gate = workflow.jobs.ci!

function runGate(results: Record<string, { result: string }>, event = "pull_request") {
  const command = gate.steps.find(step => step.env?.CI_RESULTS)?.run
  if (!command) throw new Error("The ci check must inspect dependency job results")
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
    encoding: "utf8",
    env: { ...process.env, CI_RESULTS: JSON.stringify(results), GITHUB_EVENT_NAME: event },
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
      "vp test --config vitest.config.ts --exclude test/docs-host-fixtures.test.ts",
      "vp run --ignore-depends-on examples:verify",
    ])
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

  it.each(["pull_request", "push"])("rejects a partial package test rerun with failed shards on %s", (event) => {
    const result = runGate({
      ...successfulJobs,
      "package-tests": { result: "success" },
      "package-tests-success": { result: "skipped" },
    }, event)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("package-tests-success: skipped")
  })

  it.each(["push", "workflow_dispatch"])("rejects a partial matrix rerun with failed shards on %s", (event) => {
    // A partial rerun can report matrix success while the default success()
    // condition still skips the marker because another shard remains failed.
    const result = runGate({
      ...successfulJobs,
      "consumer-contracts": { result: "success" },
      "consumer-contracts-success": { result: "skipped" },
    }, event)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("consumer-contracts-success: skipped")
  })

  it("accepts the checks intentionally skipped on pull requests", () => {
    const results = Object.fromEntries(jobNames.map(name => [name, {
      result: ["checks", "contracts-examples", "package-tests", "package-tests-success"].includes(name) ? "success" : "skipped",
    }]))
    expect(runGate(results).status).toBe(0)
    expect(runGate(results, "push").status).not.toBe(0)
  })

  it.each(jobNames)("rejects a failed or cancelled %s job", (name) => {
    for (const result of ["failure", "cancelled"]) {
      expect(runGate({ ...successfulJobs, [name]: { result } }).status).not.toBe(0)
    }
  })

  it.each(["checks", "contracts-examples", "package-tests", "package-tests-success"])("rejects skipped required job %s", (name) => {
    expect(runGate({ ...successfulJobs, [name]: { result: "skipped" } }).status).not.toBe(0)
  })

  it("requires new verification jobs to succeed unless explicitly allowed to skip", () => {
    const result = runGate({ ...successfulJobs, "new-verification": { result: "skipped" } })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("new-verification: skipped")
  })
})
