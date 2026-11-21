import type { GitHubEvidence } from "./inbox/types.ts";

/** A head that the host pushed, with the head it replaced. Only heads whose new commits are all the host's own are recorded. */
export interface HostHead {
  head: string;
  parent: string;
}

/** Author and reviewer associations that GitHub gives to people with write access to the repository. */
const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
export const hasWriteAccess = (association: unknown): boolean => writeAccess.has(String(association ?? "").toUpperCase());

export interface MaintainerApproval {
  /** A write-access reviewer's latest decisive review approves `head` or a head that it carries over to. */
  approved: boolean;
  /** Write-access reviewers whose latest decisive review requests changes. */
  changesRequested: string[];
}

const reviewer = (review: GitHubEvidence) => String(review.user?.login ?? review.author?.login ?? "").toLowerCase();

/**
 * The approval state of `head` from reviewers with write access. Each reviewer's latest APPROVED or
 * CHANGES_REQUESTED review counts; comments, pending and dismissed reviews leave it standing. An
 * approval of commit A also covers a head that the host built on A, and any head the host built on
 * that one, as `hostHeads` records them. A push by anyone else starts a head that no approval covers.
 */
export function maintainerApproval(snapshot: { reviews: Record<string, GitHubEvidence>; hostHeads?: readonly HostHead[] }, head: string): MaintainerApproval {
  const latest = new Map<string, GitHubEvidence>();
  const decisive = Object.values(snapshot.reviews)
    .filter(review => !review.deleted && hasWriteAccess(review.author_association ?? review.authorAssociation)
      && ["APPROVED", "CHANGES_REQUESTED"].includes(String(review.state ?? "").toUpperCase()))
    .sort((a, b) => String(a.submitted_at ?? a.submittedAt ?? "").localeCompare(String(b.submitted_at ?? b.submittedAt ?? "")));
  for (const review of decisive) {
    const login = reviewer(review);
    if (login) latest.set(login, review);
  }
  const changesRequested = [...latest].filter(([, review]) => String(review.state).toUpperCase() === "CHANGES_REQUESTED").map(([login]) => login);
  const approvedCommits = new Set([...latest.values()]
    .filter(review => String(review.state).toUpperCase() === "APPROVED")
    .map(review => review.commit_id ?? review.commit?.oid)
    .filter(commit => typeof commit === "string"));
  const parents = new Map((snapshot.hostHeads ?? []).map(entry => [entry.head, entry.parent]));
  let current: string | undefined = head;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    if (approvedCommits.has(current)) return { approved: true, changesRequested };
    seen.add(current);
    current = parents.get(current);
  }
  return { approved: false, changesRequested };
}
