import { describe, expect, it, vi } from "vitest"
import { PullRequestInbox, detectChangedPullRequests, openPullRequestFingerprint, probeChangedSnapshots } from "../src/server/github-inbox.ts"

const repository = "acme/app"
const head = "a".repeat(40)

function node(number: number, patch: Record<string, unknown> = {}) {
  return {
    number, title: `PR ${number}`, isDraft: false, headRefOid: head, headRefName: `fix-${number}`, baseRefName: "main", baseRefOid: "b".repeat(40),
    mergeable: "MERGEABLE", updatedAt: "2026-10-01T00:00:00Z", url: `https://github.com/${repository}/pull/${number}`, authorAssociation: "MEMBER",
    totalCommentsCount: 0, author: { login: "dev" }, headRepository: { nameWithOwner: repository }, labels: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes: [{ __typename: "CheckRun", databaseId: 1, status: "IN_PROGRESS", conclusion: null }], pageInfo: { hasNextPage: false } } } } }] },
    latestReviews: { nodes: [] }, reviewThreads: { nodes: [] },
    ...patch,
  }
}

function setup(open: () => unknown[]) {
  let now = 1_000_000
  const inbox = new PullRequestInbox({ path: ":memory:", repositories: [repository], clock: () => now })
  const graphql = vi.fn(async () => ({ data: { repository: { pullRequests: { nodes: open(), pageInfo: { hasNextPage: false, endCursor: null } } } } }))
  const rest = { state: "open" }
  const read = vi.fn(async (path: string) => path.endsWith("/pulls/7")
    ? [{ number: 7, state: rest.state, user: { login: "dev" }, head: { sha: head, ref: "fix-7" }, base: { ref: "main" }, updated_at: "2026-10-01T01:00:00Z" }]
    : [])
  const tick = async (advance = 61_000) => {
    now += advance
    await detectChangedPullRequests(inbox, () => graphql, [repository], now)
    return await probeChangedSnapshots(inbox, read, now)
  }
  return { inbox, graphql, read, rest, tick, clock: () => now }
}

describe("GitHub inbox change detection", () => {
  it("probes a PR once when its fingerprint changes and skips unchanged PRs", async () => {
    let checks = node(7)
    const f = setup(() => [checks])
    await f.inbox.seed(repository, { number: 7, state: "open", user: { login: "dev" }, head: { sha: head, ref: "fix-7" }, base: { ref: "main" } })
    expect(await f.tick()).toBe(1)
    f.read.mockClear()
    expect(await f.tick()).toBe(0)
    expect(f.read).not.toHaveBeenCalled()
    // A completed check whose delivery was lost changes the fingerprint.
    checks = node(7, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [{ __typename: "CheckRun", databaseId: 1, status: "COMPLETED", conclusion: "FAILURE" }], pageInfo: { hasNextPage: false } } } } }] } })
    expect(await f.tick()).toBe(1)
    expect(f.read).toHaveBeenCalledWith(`repos/${repository}/pulls/7`, ".")
    await f.inbox.close()
  })

  it("queries at most once a minute", async () => {
    const f = setup(() => [])
    await f.tick()
    await f.tick(10_000)
    expect(f.graphql).toHaveBeenCalledTimes(1)
    await f.inbox.close()
  })

  it("coalesces concurrent scans before reading the full snapshot summary", async () => {
    const f = setup(() => [])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    f.graphql.mockImplementation(async () => {
      await gate
      return { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }
    })
    const first = detectChangedPullRequests(f.inbox, () => f.graphql, [repository], f.clock() + 61_000)
    const second = detectChangedPullRequests(f.inbox, () => f.graphql, [repository], f.clock() + 61_000)
    release()
    await Promise.all([first, second])
    expect(f.graphql).toHaveBeenCalledTimes(1)
    await f.inbox.close()
  })

  it("seeds open PRs that no delivery reported", async () => {
    const f = setup(() => [node(8)])
    await f.tick()
    expect((await f.inbox.get(repository, 8))?.pr?.head?.sha).toBe(head)
    expect((await f.inbox.claim(1)).map(claim => claim.snapshot.number)).toEqual([8])
    await f.inbox.close()
  })

  it("probes a PR that left the open list and records it closed", async () => {
    let open = [node(7)]
    const f = setup(() => open)
    await f.inbox.seed(repository, { number: 7, state: "open", user: { login: "dev" }, head: { sha: head, ref: "fix-7" }, base: { ref: "main" } })
    await f.tick()
    open = []
    f.rest.state = "closed"
    expect(await f.tick()).toBe(1)
    expect((await f.inbox.get(repository, 7))?.status).toBe("terminal")
    await f.inbox.close()
  })

  it("marks nothing when the query fails", async () => {
    const f = setup(() => [])
    await f.inbox.seed(repository, { number: 7, state: "open", user: { login: "dev" }, head: { sha: head, ref: "fix-7" }, base: { ref: "main" } })
    f.graphql.mockResolvedValueOnce({ errors: [{ message: "rate limited" }] } as never)
    await detectChangedPullRequests(f.inbox, () => f.graphql, [repository], f.clock() + 61_000)
    expect(await f.inbox.metaEntries("snapshot-changed:")).toEqual([])
    await f.inbox.close()
  })

  it("retries a failed probe after two minutes, not on every tick", async () => {
    const f = setup(() => [node(7)])
    await f.inbox.seed(repository, { number: 7, state: "open", user: { login: "dev" }, head: { sha: head, ref: "fix-7" }, base: { ref: "main" } })
    f.read.mockRejectedValueOnce(new Error("GitHub unavailable"))
    await expect(f.tick()).rejects.toThrow("GitHub unavailable")
    expect(await probeChangedSnapshots(f.inbox, f.read, f.clock() + 10_000)).toBe(0)
    expect(await probeChangedSnapshots(f.inbox, f.read, f.clock() + 121_000)).toBe(1)
    await f.inbox.close()
  })

  it("ignores row order and keeps truncated connections visible", () => {
    const rows = (ids: number[]) => node(7, { latestReviews: { nodes: ids.map(id => ({ id: `R${id}`, state: "COMMENTED" })) } })
    expect(openPullRequestFingerprint(rows([1, 2]))).toBe(openPullRequestFingerprint(rows([2, 1])))
    expect(openPullRequestFingerprint(node(7, { mergeable: "UNKNOWN" }))).toBe(openPullRequestFingerprint(node(7)))
    expect(openPullRequestFingerprint(node(7, { mergeable: "CONFLICTING" }))).not.toBe(openPullRequestFingerprint(node(7)))
    expect(openPullRequestFingerprint(node(7, { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } }))).not.toBe(openPullRequestFingerprint(node(7)))
  })
})
