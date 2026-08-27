import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  aggregateStageEvidence,
  createStageEvidence,
  liveSmokeStages,
  updateLiveSmokeIssue,
} from "../.github/scripts/live-smoke-report.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const scriptPath = resolve(repoRoot, ".github/scripts/live-smoke-report.mjs")
const run = {
  runId: "12345",
  runAttempt: 2,
  runUrl: "https://github.com/vite-hub/vitehub/actions/runs/12345",
  observedAt: "2026-08-26T04:09:44Z",
}

const successfulJobs = { attemptProviders: ["cloudflare", "vercel"], setupStatus: "success" }

function evidence(provider: "cloudflare" | "vercel", currentStage = "runtime", conclusion = "success") {
  return createStageEvidence({ provider, currentStage, conclusion, ...run })
}

function githubFixture({ issues = [], comments = [] }: {
  issues?: Array<{ body?: string, number: number, pull_request?: object }>
  comments?: Array<{ body?: string }>
} = {}) {
  const api = {
    create: vi.fn(async () => ({ data: { number: 99 } })),
    createComment: vi.fn(async () => ({ data: {} })),
    listComments: vi.fn(async () => ({ data: comments })),
    listForRepo: vi.fn(async () => ({ data: issues })),
    update: vi.fn(async () => ({ data: {} })),
  }
  return {
    api,
    github: {
      paginate: vi.fn(async (request, options) => (await request(options)).data),
      rest: { issues: api },
    },
    context: { repo: { owner: "vite-hub", repo: "vitehub" } },
  }
}

describe("live smoke stage evidence", () => {
  it.each(liveSmokeStages)("records a %s failure without claiming later stages ran", (currentStage) => {
    const report = evidence("cloudflare", currentStage, "failure")
    const currentIndex = liveSmokeStages.indexOf(currentStage)

    expect(report.currentStage).toBe(currentStage)
    expect(report.conclusion).toBe("failure")
    expect(report.observedAt).toBe(run.observedAt)
    for (const [index, stage] of liveSmokeStages.entries()) {
      expect(report.stages[stage]).toBe(index < currentIndex ? "success" : index === currentIndex ? "failure" : "skipped")
    }
  })

  it("records all stages on a successful provider run", () => {
    expect(evidence("vercel").stages).toEqual({
      preflight: "success",
      provision: "success",
      build: "success",
      deploy: "success",
      runtime: "success",
    })
  })

  it("rejects evidence without a valid observation time", () => {
    expect(() => createStageEvidence({
      provider: "cloudflare",
      currentStage: "runtime",
      conclusion: "success",
      ...run,
      observedAt: "not-a-date",
    })).toThrow("invalid observation timestamp")
  })

  it("aggregates both matrix providers and rejects a partial green run", () => {
    const report = aggregateStageEvidence({
      evidence: [evidence("cloudflare"), evidence("vercel", "deploy", "failure")],
      ...successfulJobs,
      ...run,
    })

    expect(report.conclusion).toBe("failure")
    expect(report.observedAt).toBe(run.observedAt)
    expect(report.providers.map(provider => [provider.provider, provider.currentStage, provider.conclusion])).toEqual([
      ["cloudflare", "runtime", "success"],
      ["vercel", "deploy", "failure"],
    ])
  })

  it("turns missing matrix evidence into an explicit preflight failure", () => {
    const report = aggregateStageEvidence({ evidence: [evidence("cloudflare")], ...successfulJobs, ...run })

    expect(report.providers[1]).toMatchObject({
      provider: "vercel",
      currentStage: "preflight",
      conclusion: "failure",
      reason: "provider stage evidence was not uploaded",
    })
  })

  it("reuses the latest provider evidence from an earlier rerun attempt", () => {
    const earlierRun = { ...run, runAttempt: 1 }
    const report = aggregateStageEvidence({
      evidence: [
        createStageEvidence({ provider: "cloudflare", currentStage: "runtime", conclusion: "success", ...earlierRun }),
        createStageEvidence({ provider: "vercel", currentStage: "deploy", conclusion: "failure", ...earlierRun }),
        evidence("vercel"),
      ],
      ...successfulJobs,
      attemptProviders: ["vercel"],
      ...run,
    })

    expect(report.conclusion).toBe("success")
    expect(report.providers[0]).toMatchObject({
      provider: "cloudflare",
      conclusion: "success",
      evidenceAttempt: 1,
      run: { attempt: 2 },
    })
    expect(report.providers[1]).not.toHaveProperty("evidenceAttempt")
  })

  it("rejects stale successful evidence when the rerun matrix failed", () => {
    const earlierRun = { ...run, runAttempt: 1 }
    const report = aggregateStageEvidence({
      evidence: [
        createStageEvidence({ provider: "cloudflare", currentStage: "runtime", conclusion: "success", ...earlierRun }),
        createStageEvidence({ provider: "vercel", currentStage: "runtime", conclusion: "success", ...earlierRun }),
      ],
      setupStatus: "success",
      attemptProviders: ["cloudflare", "vercel"],
      ...run,
    })

    expect(report.conclusion).toBe("failure")
    expect(report.providers.every(provider => provider.reason === "provider job failed without current-attempt stage evidence")).toBe(true)
  })

  it("preserves an untouched successful provider when a failed job is rerun", () => {
    const earlierRun = { ...run, runAttempt: 1 }
    const report = aggregateStageEvidence({
      evidence: [
        createStageEvidence({ provider: "cloudflare", currentStage: "runtime", conclusion: "success", ...earlierRun }),
        createStageEvidence({ provider: "vercel", currentStage: "deploy", conclusion: "failure", ...earlierRun }),
      ],
      setupStatus: "success",
      attemptProviders: ["vercel"],
      ...run,
    })

    expect(report.providers[0]).toMatchObject({ provider: "cloudflare", conclusion: "success", evidenceAttempt: 1 })
    expect(report.providers[1]).toMatchObject({
      provider: "vercel",
      currentStage: "preflight",
      conclusion: "failure",
      reason: "provider job failed without current-attempt stage evidence",
    })
  })

  it("preserves untouched success when the rerun provider uploads fresh failure evidence", () => {
    const earlierRun = { ...run, runAttempt: 1 }
    const report = aggregateStageEvidence({
      evidence: [
        createStageEvidence({ provider: "cloudflare", currentStage: "runtime", conclusion: "success", ...earlierRun }),
        createStageEvidence({ provider: "vercel", currentStage: "deploy", conclusion: "failure", ...earlierRun }),
        evidence("vercel", "deploy", "failure"),
      ],
      setupStatus: "success",
      attemptProviders: ["vercel"],
      ...run,
    })

    expect(report.providers[0]).toMatchObject({ provider: "cloudflare", conclusion: "success", evidenceAttempt: 1 })
    expect(report.providers[1]).toMatchObject({ provider: "vercel", currentStage: "deploy", conclusion: "failure" })
  })

  it("rejects both stale successes when all provider jobs rerun", () => {
    const earlierRun = { ...run, runAttempt: 1 }
    const report = aggregateStageEvidence({
      evidence: [
        createStageEvidence({ provider: "cloudflare", currentStage: "runtime", conclusion: "success", ...earlierRun }),
        createStageEvidence({ provider: "vercel", currentStage: "runtime", conclusion: "success", ...earlierRun }),
      ],
      setupStatus: "success",
      attemptProviders: ["cloudflare", "vercel"],
      ...run,
    })

    expect(report.providers.every(provider => provider.reason === "provider job failed without current-attempt stage evidence")).toBe(true)
  })

  it("attributes a shared setup failure to both provider preflights", () => {
    const report = aggregateStageEvidence({ evidence: [], setupStatus: "failure", attemptProviders: [], ...run })

    expect(report.providers.every(provider => provider.currentStage === "preflight")).toBe(true)
    expect(report.providers.every(provider => provider.conclusion === "failure")).toBe(true)
  })

  it("prints JSON only from the real evidence entrypoint", () => {
    const stdout = execFileSync(process.execPath, [
      scriptPath,
      "evidence",
      "--provider", "cloudflare",
      "--stage", "build",
      "--conclusion", "failure",
      "--run-id", run.runId,
      "--run-attempt", String(run.runAttempt),
      "--run-url", run.runUrl,
    ], { encoding: "utf8" })

    expect(JSON.parse(stdout)).toMatchObject({ provider: "cloudflare", currentStage: "build", conclusion: "failure" })
  })

  it("aggregates provider fixture files through the real entrypoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "vitehub-live-smoke-report-"))
    try {
      writeFileSync(join(directory, "cloudflare.json"), JSON.stringify(evidence("cloudflare")))
      writeFileSync(join(directory, "vercel.json"), JSON.stringify(evidence("vercel")))
      const stdout = execFileSync(process.execPath, [
        scriptPath,
        "aggregate",
        "--directory", directory,
        "--setup-status", "success",
        "--attempt-providers", "cloudflare,vercel",
        "--run-id", run.runId,
        "--run-attempt", String(run.runAttempt),
        "--run-url", run.runUrl,
      ], { encoding: "utf8" })

      expect(JSON.parse(stdout)).toMatchObject({ conclusion: "success" })
    }
    finally {
      rmSync(directory, { recursive: true })
    }
  })

  it("rejects an invalid stage through stderr and status 2", () => {
    const result = spawnSync(process.execPath, [
      scriptPath,
      "evidence",
      "--provider", "cloudflare",
      "--stage", "unknown",
      "--conclusion", "failure",
      "--run-id", run.runId,
      "--run-attempt", String(run.runAttempt),
      "--run-url", run.runUrl,
    ], { encoding: "utf8" })

    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("invalid stage: unknown")
  })
})

describe("scheduled failure issue updates", () => {
  it("creates the tracked issue for the first failed run", async () => {
    const fixture = githubFixture()
    const report = aggregateStageEvidence({
      evidence: [evidence("cloudflare", "provision", "failure"), evidence("vercel")],
      ...successfulJobs,
      ...run,
    })

    await expect(updateLiveSmokeIssue({ ...fixture, report })).resolves.toEqual({ action: "created", issueNumber: 99 })
    expect(fixture.api.create).toHaveBeenCalledOnce()
    expect(fixture.api.create.mock.calls[0]?.[0].body).toContain("- cloudflare: provision (failure)")
  })

  it("comments on the tracked issue for a new failed run", async () => {
    const fixture = githubFixture({ issues: [{ body: "older run", number: 17 }] })
    const report = aggregateStageEvidence({ evidence: [evidence("cloudflare"), evidence("vercel", "runtime", "failure")], setupStatus: "success", attemptProviders: ["cloudflare", "vercel"], ...run })

    await expect(updateLiveSmokeIssue({ ...fixture, report })).resolves.toEqual({ action: "commented", issueNumber: 17 })
    expect(fixture.api.createComment).toHaveBeenCalledOnce()
    expect(fixture.api.create).not.toHaveBeenCalled()
  })

  it("deduplicates a repeated update for the same run attempt", async () => {
    const marker = `<!-- vitehub-live-smoke-run:${run.runId}:${run.runAttempt} -->`
    const fixture = githubFixture({ issues: [{ body: "older run", number: 17 }], comments: [{ body: marker }] })
    const report = aggregateStageEvidence({ evidence: [evidence("cloudflare", "build", "failure"), evidence("vercel")], setupStatus: "success", attemptProviders: ["cloudflare", "vercel"], ...run })

    await expect(updateLiveSmokeIssue({ ...fixture, report })).resolves.toEqual({ action: "deduplicated", issueNumber: 17 })
    expect(fixture.api.createComment).not.toHaveBeenCalled()
    expect(fixture.api.create).not.toHaveBeenCalled()
  })

  it("comments with green evidence and closes the tracked issue", async () => {
    const fixture = githubFixture({ issues: [{ body: "failed run", number: 17 }] })
    const report = aggregateStageEvidence({ evidence: [evidence("cloudflare"), evidence("vercel")], ...successfulJobs, ...run })

    await expect(updateLiveSmokeIssue({ ...fixture, report })).resolves.toEqual({ action: "closed", issueNumber: 17 })
    expect(fixture.api.createComment).toHaveBeenCalledOnce()
    expect(fixture.api.update).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 17,
      state: "closed",
      state_reason: "completed",
    }))
  })
})

describe("live smoke workflow reporting contract", () => {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/live-smoke.yml"), "utf8")

  it("grants only the reporter the permissions needed to read evidence and update issues", () => {
    const reporter = workflow.slice(workflow.indexOf("  report-live-smoke:"))
    expect(workflow).toMatch(/permissions:\n  contents: read/)
    expect(reporter).toContain("actions: read")
    expect(reporter).toContain("contents: read")
    expect(reporter).toContain("issues: write")
  })

  it("records every named stage and aggregates both matrix providers", () => {
    expect(workflow).toContain("LIVE_SMOKE_STAGE: preflight")
    for (const stage of liveSmokeStages.slice(1)) {
      expect(workflow).toContain(`LIVE_SMOKE_STAGE=${stage}`)
    }
    expect(workflow).toContain("if: always()")
    expect(workflow).toContain("pattern: live-smoke-evidence-*")
    expect(workflow).not.toContain("timeout-minutes: 30")
    expect(workflow).not.toContain("merge-multiple: true")
    expect(workflow).toContain("listJobsForWorkflowRunAttempt")
    expect(workflow).toContain('--attempt-providers "$LIVE_SMOKE_ATTEMPT_PROVIDERS"')
    expect(workflow).toContain("github.event_name == 'workflow_dispatch' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
  })
})
