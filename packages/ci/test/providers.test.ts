import { beforeEach, describe, expect, it, vi } from "vitest"

const requests: Array<{ path: string, options: unknown, baseURL?: string, headers?: Record<string, string> }> = []
const queue: unknown[] = []

vi.mock("ofetch", () => ({
  ofetch: {
    create: vi.fn((config: { baseURL?: string, headers?: Record<string, string> }) => {
      return vi.fn(async (path: string, options?: unknown) => {
        requests.push({ path, options, baseURL: config.baseURL, headers: config.headers })
        const next = queue.shift()
        if (next instanceof Error) throw next
        return next
      })
    }),
  },
}))

describe("@vitehub/ci providers", () => {
  beforeEach(() => {
    requests.length = 0
    queue.length = 0
  })

  it("normalizes Cloudflare builds and logs", async () => {
    const { createCIProvider } = await import("../src/index.ts")
    const provider = createCIProvider("cloudflare")
    queue.push({
      result: [
        { id: "worker-tag" },
      ],
    })
    queue.push({
      result: [{
        build_uuid: "build-1",
        external_script_id: "worker-tag",
        build_status: "stopped",
        build_outcome: "fail",
        created_on: "2026-05-12T10:00:00Z",
        running_on: "2026-05-12T10:01:00Z",
        stopped_on: "2026-05-12T10:02:00Z",
        build_trigger_metadata: {
          branch: "main",
          commit_hash: "abc123",
          commit_message: "Ship",
          author: "Max",
          build_trigger_source: "push",
          provider_account_name: "owner",
          repo_name: "repo",
        },
      }],
    })

    const allRuns = await provider.listRuns({ token: "token", accountID: "account" })
    expect(requests[0]?.baseURL).toBe("https://api.cloudflare.com/client/v4")
    expect(requests[0]?.headers?.authorization).toBe("Bearer token")
    expect(requests[0]?.path).toBe("/accounts/account/workers/scripts")
    expect(requests[1]?.path).toBe("/accounts/account/builds/workers/worker-tag/builds")
    expect(allRuns[0]).toMatchObject({
      id: "build-1",
      provider: "cloudflare",
      projectID: "worker-tag",
      branch: "main",
      commitSha: "abc123",
      trigger: "push",
      status: "completed",
      outcome: "failed",
      sourceUrl: "https://github.com/owner/repo/commit/abc123",
    })

    queue.push({
      result: [{
        build_uuid: "build-1",
        external_script_id: "worker-tag",
        build_status: "stopped",
        build_outcome: "fail",
        created_on: "2026-05-12T10:00:00Z",
        running_on: "2026-05-12T10:01:00Z",
        stopped_on: "2026-05-12T10:02:00Z",
        build_trigger_metadata: {
          branch: "main",
          commit_hash: "abc123",
          commit_message: "Ship",
          author: "Max",
          build_trigger_source: "push",
          provider_account_name: "owner",
          repo_name: "repo",
        },
      }],
    })

    const projectRuns = await provider.listRuns({ token: "token", accountID: "account" }, { projectID: "worker-tag" })
    expect(requests[2]?.path).toBe("/accounts/account/builds/workers/worker-tag/builds")
    expect(projectRuns[0]).toMatchObject({
      id: "build-1",
      provider: "cloudflare",
      projectID: "worker-tag",
      branch: "main",
      commitSha: "abc123",
      trigger: "push",
      status: "completed",
      outcome: "failed",
      sourceUrl: "https://github.com/owner/repo/commit/abc123",
    })

    queue.push({ result: { lines: [[1_746_000_000, "Build failed"]], cursor: "next", truncated: true } })
    const logs = await provider.getLogs({ token: "token", accountID: "account" }, "build-1")
    expect(requests[3]?.path).toBe("/accounts/account/builds/builds/build-1/logs")
    expect(logs).toMatchObject({
      cursor: "next",
      truncated: true,
      lines: [{ timestamp: "2025-04-30T08:00:00.000Z", message: "Build failed", stream: "unknown" }],
    })
  })

  it("normalizes Vercel deployments and build events", async () => {
    const { createCIProvider } = await import("../src/index.ts")
    const provider = createCIProvider("vercel")
    queue.push({
      deployments: [{
        uid: "dpl_1",
        name: "web",
        url: "web.vercel.app",
        readyState: "ERROR",
        createdAt: 1_746_000_000_000,
        buildingAt: 1_746_000_010_000,
        meta: {
          githubCommitRef: "main",
          githubCommitSha: "abc123",
          githubCommitMessage: "Ship",
          githubOrg: "owner",
          githubRepo: "repo",
          githubCommitAuthorName: "Max",
        },
      }],
    })

    const runs = await provider.listRuns({ token: "token", teamID: "team_1" }, { projectName: "web", branch: "main", commitSha: "abc123", limit: 1 })
    expect(requests[0]?.baseURL).toBe("https://api.vercel.com")
    expect(requests[0]?.path).toContain("/v6/deployments?")
    expect(requests[0]?.path).toContain("app=web")
    expect(requests[0]?.path).toContain("teamId=team_1")
    expect(runs[0]).toMatchObject({
      id: "dpl_1",
      provider: "vercel",
      projectID: "web",
      branch: "main",
      commitSha: "abc123",
      status: "completed",
      outcome: "failed",
      webUrl: "https://web.vercel.app",
      sourceUrl: "https://github.com/owner/repo/commit/abc123",
    })

    queue.push([{ created: 1_746_000_000_000, payload: { text: "npm ERR! failed", info: { type: "stderr" } } }])
    const logs = await provider.getLogs({ token: "token" }, "dpl_1", { limit: 10 })
    expect(requests[1]?.path).toBe("/v3/deployments/dpl_1/events?builds=1&direction=forward&limit=10")
    expect(logs.lines[0]).toMatchObject({ timestamp: "2025-04-30T08:00:00.000Z", message: "npm ERR! failed", stream: "stderr" })
  })

  it("normalizes GitHub workflow runs and job logs", async () => {
    const { createCIProvider } = await import("../src/index.ts")
    const provider = createCIProvider("github")
    queue.push([
      { full_name: "owner/repo" },
    ])
    queue.push({
      workflow_runs: [{
        id: 123,
        name: "CI",
        head_branch: "main",
        head_sha: "abc123",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/owner/repo/actions/runs/123",
        created_at: "2026-05-12T10:00:00Z",
        run_started_at: "2026-05-12T10:01:00Z",
        updated_at: "2026-05-12T10:02:00Z",
        triggering_actor: { login: "maxi" },
        repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
        head_commit: { message: "Ship", author: { name: "Max" } },
      }],
    })

    const runs = await provider.listRuns({ token: "token", owner: "owner" }, { branch: "main", limit: 5 })
    expect(requests[0]?.baseURL).toBe("https://api.github.com")
    expect(requests[0]?.headers?.accept).toBe("application/vnd.github+json")
    expect(requests[0]?.path).toBe("/users/owner/repos?per_page=100&sort=pushed&type=all")
    expect(requests[1]?.path).toBe("/repos/owner/repo/actions/runs?branch=main&per_page=5")
    expect(runs[0]).toMatchObject({
      id: "123",
      provider: "github",
      projectID: "owner/repo",
      projectName: "CI",
      branch: "main",
      commitSha: "abc123",
      trigger: "pull_request",
      status: "completed",
      outcome: "success",
      sourceUrl: "https://github.com/owner/repo/commit/abc123",
    })

    queue.push({ jobs: [{ id: 1, name: "build", conclusion: "failure" }, { id: 2, name: "lint", conclusion: "success" }] })
    queue.push("line 1\nTypeError: nope")
    queue.push("ok")
    const logs = await provider.getLogs({ token: "token", owner: "owner", repo: "repo" }, "123")
    expect(requests[2]?.path).toBe("/repos/owner/repo/actions/runs/123/jobs")
    expect(requests[3]?.path).toBe("/repos/owner/repo/actions/jobs/1/logs")
    expect(requests[4]?.path).toBe("/repos/owner/repo/actions/jobs/2/logs")
    expect(logs.lines.map((line) => line.message)).toEqual(["## build", "line 1", "TypeError: nope", "## lint", "ok"])
  })
})
