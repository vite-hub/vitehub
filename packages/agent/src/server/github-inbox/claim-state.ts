import type { PullRequest } from '../github-pull-requests.ts'
import type { Claim, Snapshot } from './store.ts'

/** REST fields are authoritative; older persisted GraphQL aliases may be stale. */
export function snapshotPullRequest(snapshot: Snapshot): PullRequest {
  const pr = snapshot.pr
  if (!pr?.head?.sha || !pr.head.ref || !pr.base?.ref) throw new Error(`Incomplete PR snapshot for ${snapshot.repository}#${snapshot.number}`)
  return {
    ...pr,
    number: snapshot.number,
    state: String(pr.state).toUpperCase(),
    headRefOid: pr.head.sha,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    baseRefOid: pr.base.sha ?? '',
    body: pr.body ?? '',
    reviewDecision: pr.reviewDecision ?? '',
    statusCheckRollup: Object.values(snapshot.checks).map(check => ({ ...check, name: check.name ?? check.context, status: String(check.status ?? '').toUpperCase(), conclusion: String(check.conclusion ?? '').toUpperCase() })),
    headRepository: pr.head.repo ? { nameWithOwner: pr.head.repo.full_name } : null,
        isDraft: Boolean(pr.draft),
    url: pr.html_url ?? '',
    updatedAt: pr.updated_at ?? '',
    title: pr.title ?? '',
    mergeStateStatus: String(pr.mergeable_state ?? 'UNKNOWN').toUpperCase(),
  }
}

export function claimStopReason(claim: Claim, current: Snapshot | undefined, acceptedSelfHead?: string): string | undefined {
  if (!current || current.lease !== claim.token) return 'Pull request lease lost.'
  if (current.status === 'terminal' || current.pr?.state === 'closed') return 'Pull request is no longer open.'
  if (current.pr?.head?.sha !== (acceptedSelfHead ?? claim.snapshot.pr?.head?.sha)) return 'Pull request head changed.'
}


/** A new remote head may be our repair; prove it against the actual provider Git HEAD. */
export function createClaimStopCheck(
  claim: Claim,
  readCurrent: () => Snapshot | undefined,
  readProviderHead: () => Promise<string | undefined>,
): () => Promise<string | undefined> {
  let acceptedSelfHead: string | undefined
  return async (): Promise<string | undefined> => {
    const reason = claimStopReason(claim, readCurrent(), acceptedSelfHead)
    if (reason !== 'Pull request head changed.') return reason
    let providerHead: string | undefined
    try { providerHead = await readProviderHead() }
    catch { return claimStopReason(claim, readCurrent(), acceptedSelfHead) }
    // A closed PR, lease loss, or another push may arrive during Git I/O.
    const current = readCurrent()
    const latestReason = claimStopReason(claim, current, acceptedSelfHead)
    if (latestReason !== 'Pull request head changed.') return latestReason
    if (!providerHead || current?.pr?.head?.sha !== providerHead) return latestReason
    // Persist this proof for the lifetime of the pass so provider cleanup
    // cannot turn a verified self-push into a spurious cancellation.
    acceptedSelfHead = providerHead
    return undefined
  }
}
