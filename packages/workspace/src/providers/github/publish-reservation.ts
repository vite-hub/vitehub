import { randomUUID } from "node:crypto"
import * as v from "valibot"

import { workspaceConflict, workspaceError } from "../../core/errors.ts"
import { githubRequest, githubRequestStatus, readCurrentHead, type GitHubRepository } from "./shared.ts"

export const githubPublishReservationMs = 5 * 60_000
const zeroOid = "0".repeat(40)
const leaseSchema = v.object({
  vitehubPublishReservation: v.literal(1),
  owner: v.string(),
  expiresAt: v.number(),
  head: v.string(),
  opening: v.optional(v.string()),
})
const commitSchema = v.object({
  message: v.string(),
  tree: v.object({ sha: v.string() }),
  committer: v.optional(v.object({ date: v.string() })),
})

/** Expiring preparation claims become durable before dispatching a mutation whose outcome might be ambiguous. */
export async function acquireGitHubPublishReservation(repository: GitHubRepository, options: { branch: string, head: string, path: string }) {
  const busy = () => workspaceConflict(`[vitehub] A publish is already opening a pull request for ${options.path}. Retry after it finishes or its reservation expires.`, { details: { ref: "pull-request", path: options.path } })
  const expiresAt = Date.now() + githubPublishReservationMs
  const route = (repo: { owner: string, name: string }) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  const readCommit = (sha: string) => githubRequest(repository, async (provider, repo) => v.parse(commitSchema,
    (await provider.request<unknown>("GET", `${route(repo)}/git/commits/${encodeURIComponent(sha)}`)).data))
  const base = await readCommit(options.head)
  const owner = randomUUID()
  const writeClaim = (opening?: string) => githubRequest(repository, async (provider, repo) => v.parse(v.object({ sha: v.string() }),
    (await provider.request<unknown>("POST", `${route(repo)}/git/commits`, { body: {
      message: JSON.stringify({ vitehubPublishReservation: 1, owner, expiresAt, head: options.head, ...(opening ? { opening } : {}) }),
      parents: [options.head],
      tree: base.tree.sha,
    } })).data).sha)
  let owned = await writeClaim()

  async function graphql(query: string, operationName: string, variables: Record<string, unknown>): Promise<unknown> {
    return githubRequest(repository, async (provider) => {
      const response = v.parse(v.object({ data: v.optional(v.unknown()), errors: v.optional(v.array(v.object({ message: v.string() }))) }),
        (await provider.request<unknown>("POST", "/graphql", { body: { query, operationName, variables } })).data)
      if (response.errors?.length) throw workspaceError(`[vitehub] GitHub publish reservation failed: ${response.errors.map(error => error.message).join("; ")}`)
      return response.data
    })
  }

  // updateRefs.beforeOid is GitHub's atomic compare-and-swap, including deletion with a zero afterOid.
  async function replace(expected: string, next: string): Promise<boolean> {
    const repo = await githubRequest(repository, async (_provider, repo) => repo)
    const { repository: { id } } = v.parse(v.object({ repository: v.object({ id: v.string() }) }), await graphql(
      "query RepositoryId($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}", "RepositoryId", { owner: repo.owner, name: repo.name }))
    try {
      v.parse(v.object({ updateRefs: v.object({ clientMutationId: v.nullable(v.string()) }) }), await graphql(
        "mutation UpdateRefs($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}", "UpdateRefs", {
          input: { repositoryId: id, refUpdates: [{ name: `refs/heads/${options.branch}`, beforeOid: expected, afterOid: next, force: true }] },
        }))
      return true
    }
    catch (error) {
      const current = await readCurrentHead(repository, options.branch)
      if (current === next) return true
      if (current !== expected) return false
      throw error
    }
  }

  try {
    await githubRequest(repository, async (provider, repo) => await provider.request("POST", `${route(repo)}/git/refs`, {
      body: { ref: `refs/heads/${options.branch}`, sha: owned },
    }))
  }
  catch (error) {
    if (githubRequestStatus(error) !== 422) throw error
    const current = await readCurrentHead(repository, options.branch)
    if (!current) throw error
    const commit = await readCommit(current)
    let expiry: number
    let opening: string | undefined
    try {
      const lease = v.parse(leaseSchema, JSON.parse(commit.message))
      expiry = lease.expiresAt
      opening = lease.opening
    }
    catch {
      // Older releases pointed the reservation directly at the publish commit, without an owner or deadline.
      expiry = Date.parse(commit.committer?.date ?? "") + githubPublishReservationMs
    }
    if (!Number.isFinite(expiry) || expiry > Date.now()) throw busy()
    if (opening) {
      // A timeout, lost response, or crashed client does not cancel GitHub's mutation. Only an observed PR
      // (including a closed/retargeted one) proves that attempt completed, allowing the normal open-PR recheck.
      const completed = await githubRequest(repository, async (provider, repo) => {
        const query = new URLSearchParams({ state: "all", head: `${repo.owner}:${opening}`, per_page: "1" })
        const requests = v.parse(v.array(v.object({ head: v.object({ ref: v.string() }) })),
          (await provider.request<unknown>("GET", `${route(repo)}/pulls?${query}`)).data)
        return requests.some(request => request.head.ref === opening)
      })
      if (!completed) throw workspaceConflict(`[vitehub] GitHub has not confirmed the publish pull request from ${opening} for ${options.path}. Keep its branch and reservation; retry after GitHub reports the result.`, { details: { ref: "pull-request", path: options.path, head: opening } })
    }
    if (!await replace(current, owned)) throw busy()
  }

  async function assertOwned(): Promise<void> {
    if (await readCurrentHead(repository, options.branch) !== owned || Date.now() >= expiresAt) throw busy()
  }

  return {
    expiresAt,
    assertOwned,
    async begin(opening: string): Promise<void> {
      await assertOwned()
      const previous = owned
      owned = await writeClaim(opening)
      if (!await replace(previous, owned)) throw busy()
    },
    async release(): Promise<void> {
      await replace(owned, zeroOid)
    },
  }
}
