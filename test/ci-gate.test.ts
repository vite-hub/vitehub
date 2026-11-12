import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { array, object, optional, parse, pipe, record, string, transform, union, unknown } from "valibot"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

const workflowSchema = object({ permissions: record(string(), string()), jobs: record(string(), object({
  permissions: optional(record(string(), string())),
  needs: optional(pipe(union([string(), array(string())]), transform(value => typeof value === "string" ? [value] : value))),
  if: optional(string()),
  steps: array(object({ name: optional(string()), if: optional(string()), run: optional(string()), env: optional(record(string(), string())) })),
})) })
const workflow = parse(workflowSchema, parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")))
const jobNames = Object.keys(workflow.jobs).filter(name => name !== "ci")
const gate = workflow.jobs.ci!

function runGate(results: Record<string, { result: string }>, event = "pull_request", fullSuite = event !== "pull_request") {
  const command = gate.steps.find(step => step.env?.CI_RESULTS)?.run
  if (!command) throw new Error("The ci check must inspect dependency job results")
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
    encoding: "utf8",
    env: { ...process.env, CI_RESULTS: JSON.stringify(results), GITHUB_EVENT_NAME: event, FULL_SUITE: String(fullSuite) },
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

  it("waits for every verification job and runs even when a dependency fails", () => {
    expect(gate.needs?.toSorted()).toEqual(jobNames.toSorted())
    expect(gate.if).toBe("${{ always() }}")
  })

  it.each(["pull_request", "push", "workflow_dispatch"])("accepts successful checks on %s", (event) => {
    const result = runGate(successfulJobs, event)
    expect(result.status, result.stderr).toBe(0)
  })

  const sites = { docs: "docs-deploy", console: "console-deploy" }

  it.each(Object.entries(sites))("requires successful %s verification and deployment on pushes", (build, deploy) => {
    for (const name of [build, deploy]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        const run = runGate({ ...successfulJobs, [name]: { result } }, "push")
        expect(run.status, `${name}: ${result}`).not.toBe(0)
        expect(run.stderr).toContain(`${name}: ${result}`)
      }
    }
    expect(runGate({ ...successfulJobs, [deploy]: { result: "skipped" } }).status).toBe(0)
  })

  it("rejects a stale Console with the same entry script, including workflow reruns", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-console-deploy-"))
    const output = join(directory, "packages/vite-hub/.vitehub/console-account")
    const live = join(directory, "live.html")
    const identify = workflow.jobs.console?.steps.find(step => step.name === "Identify Console build")?.run
    const check = workflow.jobs["console-deploy"]?.steps.find(step => step.name === "Check the live site")?.run
    if (!check) throw new Error("The Console deployment must check the live site")
    const html = '<html><head><script type="module" src="/assets/console-unchanged.js"></script></head></html>'
    const run = (command: string, attempt: string, curlStatus = "0") => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_SHA: "same-commit", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: attempt, LIVE_HTML: live, CURL_STATUS: curlStatus },
    })
    try {
      mkdirSync(output, { recursive: true })
      for (const [name, contents] of Object.entries({ curl: '#!/bin/sh\ncat "$LIVE_HTML"\nexit "$CURL_STATUS"\n', sleep: "#!/bin/sh\nexit 0\n" })) {
        const path = join(directory, name)
        writeFileSync(path, contents)
        chmodSync(path, 0o755)
      }
      for (const attempt of ["1", "2"]) {
        writeFileSync(join(output, "index.html"), html)
        if (identify) {
          const result = run(identify, attempt)
          expect(result.status, result.stderr).toBe(0)
        }
        if (attempt === "1") writeFileSync(live, readFileSync(join(output, "index.html")))
      }

      const stale = run(check, "2")
      expect(stale.status, "An older deployment with an unchanged entry must fail").not.toBe(0)
      expect(stale.stderr).toContain("does not serve this build")

      writeFileSync(live, readFileSync(join(output, "index.html")))
      const current = run(check, "2")
      expect(current.status, current.stderr).toBe(0)
      expect(run(check, "2", "22").status, "An unsuccessful HTTP response must fail even with the expected marker").not.toBe(0)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("accepts the reused build when only the Console deploy job is rerun, and rejects a build of another run", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-console-deploy-rerun-"))
    const output = join(directory, "packages/vite-hub/.vitehub/console-account")
    const live = join(directory, "live.html")
    const identify = workflow.jobs.console?.steps.find(step => step.name === "Identify Console build")?.run
    const check = workflow.jobs["console-deploy"]?.steps.find(step => step.name === "Check the live site")?.run
    if (!identify || !check) throw new Error("The Console build must mark its output and the deployment must check the live site")
    const run = (command: string, runId: string, attempt: string) => spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_SHA: "same-commit", GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, LIVE_HTML: live, CURL_STATUS: "0" },
    })
    try {
      mkdirSync(output, { recursive: true })
      for (const [name, contents] of Object.entries({ curl: '#!/bin/sh\ncat "$LIVE_HTML"\nexit "$CURL_STATUS"\n', sleep: "#!/bin/sh\nexit 0\n" })) {
        const path = join(directory, name)
        writeFileSync(path, contents)
        chmodSync(path, 0o755)
      }
      writeFileSync(join(output, "index.html"), "<html><head></head></html>")
      // Attempt 1 builds and deploys. Only console-deploy is rerun as attempt 2, with the artifact of attempt 1.
      expect(run(identify, "123", "1").status).toBe(0)
      writeFileSync(live, readFileSync(join(output, "index.html")))
      const rerun = run(check, "123", "2")
      expect(rerun.status, rerun.stderr).toBe(0)

      const otherRun = run(check, "456", "1")
      expect(otherRun.status, "A build of another run must fail even when the site serves it").not.toBe(0)
      expect(otherRun.stderr).toContain("no deployment marker for this commit and run")
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

  const pullRequestJobs = [
    "checks",
    "workflow-lint",
    "contract-tests",
    "package-tests",
    "package-tests-success",
    "docs",
    "docs-snippets",
    "console",
  ]

  it("accepts the checks intentionally skipped on pull requests", () => {
    const results = Object.fromEntries(jobNames.map(name => [name, {
      result: ["checks", "workflow-lint", "contracts-examples", "contract-tests", "package-tests", "package-tests-success", "service-tests", "docs", "docs-snippets", "console"].includes(name) ? "success" : "skipped",
    }]))
    expect(runGate(results).status).toBe(0)
    expect(runGate(results, "push").status).not.toBe(0)
  })

  it.each(["node-22", "prepublish-contracts"])("requires %s on pushes, manual dispatches and repair-main pull requests", (name) => {
    const results = { ...successfulJobs, [name]: { result: "skipped" } }
    expect(runGate(results, "pull_request").status).toBe(0)
    expect(runGate(results, "push").status).not.toBe(0)
    expect(runGate(results, "workflow_dispatch").status).not.toBe(0)
    expect(runGate(results, "pull_request", true).status).not.toBe(0)
  })

  it("rejects the push-only checks skipped on a repair-main pull request", () => {
    // A repair that passed only the pull request checks merged and left main red.
    const results = Object.fromEntries(jobNames.map(name => [name, {
      result: pullRequestJobs.includes(name) ? "success" : "skipped",
    }]))
    const result = runGate({ ...results, "docs-deploy": { result: "skipped" } }, "pull_request", true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("contracts-examples: skipped")
    expect(result.stderr).toContain("node-22: skipped")
    expect(result.stderr).toContain("prepublish-contracts: skipped")
  })

  it.each(pullRequestJobs)("rejects a skipped %s on pull requests", (name) => {
    expect(runGate({ ...successfulJobs, [name]: { result: "skipped" } }).status).not.toBe(0)
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
  const liveSmokeSource = parseYaml(readFileSync(new URL("../.github/workflows/live-smoke.yml", import.meta.url), "utf8"))
  const liveSmoke = parse(workflowSchema, liveSmokeSource)
  const liveSmokeCheckouts = parse(object({ jobs: record(string(), object({ steps: array(object({
    uses: optional(string()),
    with: optional(record(string(), unknown())),
  })) })) }), liveSmokeSource)

  it("tests the newest main commit with successful CI before building and deploying", () => {
    const setup = liveSmoke.jobs["setup-cloudflare"]
    expect(setup?.permissions).toEqual({ actions: "read", contents: "read" })
    expect(liveSmoke.jobs["live-smoke"]?.needs).toEqual(["setup-cloudflare"])
    const command = setup?.steps[0]?.run
    if (!command) throw new Error("Live smoke must pick a green main commit before it checks out code")
    expect(command).toContain("actions/workflows/ci.yml/runs")
    expect(command).toContain("-f branch=main -f event=push -f status=success")
    expect(setup?.steps[0]?.env?.MAX_CI_AGE_HOURS).toBe("48")
    const directory = mkdtempSync(join(tmpdir(), "vitehub-live-ci-gate-"))
    writeFileSync(join(directory, "gh"), `#!/bin/sh
printf "%s\\n" "$*" >> "$GH_CALLS"
case "$2" in
  */actions/workflows/ci.yml/runs) printf "%s" "$GREEN_RUN"; exit "$RUNS_API_STATUS" ;;
  */compare/*) printf "%s\\n" "$COMPARE_STATUS"; exit "$COMPARE_API_STATUS" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
    const run = (overrides: Record<string, string>) => {
      const env = {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GH_CALLS: join(directory, "calls"),
        GITHUB_OUTPUT: join(directory, "output"),
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: "vite-hub/vitehub",
        MAX_CI_AGE_HOURS: "48",
        GREEN_RUN: "green-sha https://github.com/vite-hub/vitehub/actions/runs/1\n",
        RUNS_API_STATUS: "0",
        COMPARE_STATUS: "ahead",
        COMPARE_API_STATUS: "0",
        ...overrides,
      }
      for (const file of [env.GH_CALLS, env.GITHUB_OUTPUT]) writeFileSync(file, "")
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", command], { encoding: "utf8", env })
      return { ...result, calls: readFileSync(env.GH_CALLS, "utf8"), output: readFileSync(env.GITHUB_OUTPUT, "utf8") }
    }
    try {
      for (const position of ["ahead", "identical"]) {
        const result = run({ COMPARE_STATUS: position })
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(result.output).toBe("sha=green-sha\n")
        expect(result.calls).toContain("repos/vite-hub/vitehub/compare/green-sha...main")
      }
      const since = /created=>=(\S+)/.exec(run({}).calls)?.[1]
      const age = Date.now() - Date.parse(since ?? "")
      expect(age).toBeGreaterThan(47.9 * 3_600_000)
      expect(age).toBeLessThan(48.1 * 3_600_000)

      const failures = {
        "a ref other than main": { GITHUB_REF: "refs/heads/feature" },
        "no green run in the window": { GREEN_RUN: "" },
        "an unavailable runs API": { RUNS_API_STATUS: "1" },
        "a green commit that main no longer contains": { COMPARE_STATUS: "diverged" },
        "an unavailable compare API": { COMPARE_API_STATUS: "1" },
      }
      for (const [name, overrides] of Object.entries(failures)) {
        const result = run(overrides)
        expect(result.status, name).not.toBe(0)
        expect(result.output, name).toBe("")
      }
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("checks out the picked commit in every job that runs repository code", () => {
    const checkoutRef = (job: string) => liveSmokeCheckouts.jobs[job]?.steps.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.ref
    expect(checkoutRef("setup-cloudflare")).toBe("${{ steps.green.outputs.sha }}")
    expect(checkoutRef("live-smoke")).toBe("${{ needs.setup-cloudflare.outputs.sha }}")
    expect(checkoutRef("report-live-smoke")).toBe("${{ needs.setup-cloudflare.outputs.sha }}")
  })
})
