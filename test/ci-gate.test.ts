import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { array, object, optional, parse, record, string } from "valibot"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

const workflow = parse(object({ jobs: record(string(), object({
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
      result: ["checks", "package-tests"].includes(name) ? "success" : "skipped",
    }]))
    expect(runGate(results).status).toBe(0)
    expect(runGate(results, "push").status).not.toBe(0)
  })

  it.each(jobNames)("rejects a failed or cancelled %s job", (name) => {
    for (const result of ["failure", "cancelled"]) {
      expect(runGate({ ...successfulJobs, [name]: { result } }).status).not.toBe(0)
    }
  })

  it.each(["checks", "package-tests"])("rejects skipped required job %s", (name) => {
    expect(runGate({ ...successfulJobs, [name]: { result: "skipped" } }).status).not.toBe(0)
  })
})
