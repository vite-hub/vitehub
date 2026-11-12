import type { GitHubPullRequestFilter, GitHubPullRequestFilterContext, GitHubPullRequestFilterRules } from "@vite-hub/agent/channels";
import { matchesGitHubPullRequestFilter } from "@vite-hub/agent/channels";

/** The values GitHub reports in a pull request's `author_association`. */
export const githubAuthorAssociations = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"] as const;

/**
 * Compares GitHub logins. REST names a bot `renovate[bot]` and GraphQL names it `renovate`, and
 * logins are case-insensitive, so both spellings of one account give the same key.
 */
export function githubLoginKey(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

/** Whether `logins` names `login` in either bot spelling. */
export function hasGitHubLogin(logins: ReadonlySet<string> | readonly string[] | undefined, login: string): boolean {
  if (!login.trim()) return false;
  const key = githubLoginKey(login);
  for (const entry of logins ?? []) if (githubLoginKey(entry) === key) return true;
  return false;
}

function loginRules(rules: GitHubPullRequestFilterRules | undefined): GitHubPullRequestFilterRules | undefined {
  return rules && { ...rules.allow ? { allow: rules.allow.map(githubLoginKey) } : {}, ...rules.deny ? { deny: rules.deny.map(githubLoginKey) } : {} };
}

/**
 * `author` and `authorAssociation` select the PR's author together: a PR passes when it matches
 * either allow list, and a match on either deny list rejects it. With one of them set, it works alone.
 */
function authorMatches(value: GitHubPullRequestFilterContext, filter: GitHubPullRequestFilter | undefined): boolean {
  const author = filter?.author;
  const association = filter?.authorAssociation;
  if (!author && !association) return true;
  const login = value.author === undefined ? undefined : githubLoginKey(value.author);
  const role = value.authorAssociation?.toUpperCase();
  if (login !== undefined && author?.deny?.some(entry => githubLoginKey(entry) === login)) return false;
  if (role !== undefined && association?.deny?.includes(role)) return false;
  const allowed = [
    author?.allow?.length ? login !== undefined && author.allow.some(entry => githubLoginKey(entry) === login) : undefined,
    association?.allow?.length ? role !== undefined && association.allow.includes(role) : undefined,
  ].filter(result => result !== undefined);
  if (allowed.length) return allowed.includes(true);
  // Deny-only rules still need the value they check.
  return !(author && login === undefined) && !(association && role === undefined);
}

/** The GitHub Channel filter, with bot logins compared in either spelling and the author rules combined. */
export function matchesBabysitterPullRequestFilter(
  value: GitHubPullRequestFilterContext,
  filter: GitHubPullRequestFilter | undefined,
  scope: "event" | "pull-request" = "event",
): boolean {
  const rest = { ...filter, author: undefined, authorAssociation: undefined, actor: loginRules(filter?.actor) };
  const context = { ...value, actor: value.actor === undefined ? undefined : githubLoginKey(value.actor) };
  return matchesGitHubPullRequestFilter(context, rest, scope) && authorMatches(value, filter);
}
