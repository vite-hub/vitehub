/** How long the GitHub token of a person's last request stays usable for the pull request sync that it started. */
const tokenLifetime = 10 * 60_000

const tokens = new Map<string, { token: string, until: number }>()

/**
 * Keeps the GitHub token of a person who signed in with GitHub, so the pull request sync that runs after their request
 * can post as them. The token lives in their session cookie; this copy stays in memory for ten minutes.
 */
export function rememberGitHubToken(authorId: string, token: string): void {
  const now = Date.now()
  if (tokens.size > 1000) {
    for (const [id, entry] of tokens) if (entry.until <= now) tokens.delete(id)
  }
  tokens.set(authorId, { token, until: now + tokenLifetime })
}

/** The GitHub token of a person's request in the last ten minutes. */
export function recentGitHubToken(authorId: string): string | undefined {
  const entry = tokens.get(authorId)
  if (!entry) return
  if (entry.until > Date.now()) return entry.token
  tokens.delete(authorId)
}

/** Drops the token of a person who signs out. */
export function forgetGitHubToken(authorId: string): void {
  tokens.delete(authorId)
}
