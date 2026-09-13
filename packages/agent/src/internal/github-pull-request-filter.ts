import type { GitHubPullRequestFilter, GitHubPullRequestFilterContext, GitHubPullRequestFilterRules } from '../channels.ts'

export function githubPullRequestFilterRule(value: string | boolean | undefined, rule: GitHubPullRequestFilterRules | undefined): boolean {
  if (!rule) return true
  if (value === undefined) return false
  const text = String(value)
  if (rule.deny?.includes(text)) return false
  return !rule.allow || rule.allow.length === 0 || rule.allow.includes(text)
}

/** Event rules apply at admission. Durable eligibility has no actor or action. */
export function matchesGitHubPullRequestFilter(
  value: GitHubPullRequestFilterContext,
  filter: GitHubPullRequestFilter | undefined,
  scope: 'event' | 'pull-request' = 'event',
): boolean {
  const keys = ['repository', 'author', 'authorAssociation', 'draft', 'fork', 'base', 'head', 'title'] as const
  if (keys.some(key => !githubPullRequestFilterRule(value[key], filter?.[key]))) return false
  if (scope === 'event' && (!githubPullRequestFilterRule(value.actor, filter?.actor) || !githubPullRequestFilterRule(value.action, filter?.action))) return false
  if (filter?.labels) {
    const labels = value.labels ?? []
    if (filter.labels.deny?.some(label => labels.includes(label))) return false
    if (filter.labels.allow && !filter.labels.allow.some(label => labels.includes(label))) return false
  }
  return true
}
