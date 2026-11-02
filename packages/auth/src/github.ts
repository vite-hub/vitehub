export interface GitHubOrgMemberOptions {
  /** Keep a successful check for this many milliseconds per token and organization. Default: no cache. */
  cacheMs?: number
  /** Give up on the GitHub request after this many milliseconds. Default: 5000. */
  timeoutMs?: number
}

// Keys are SHA-256 digests, so the cache never holds a token.
const activeUntil = new Map<string, number>()

async function cacheKey(accessToken: string, org: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${org.toLowerCase()}\n${accessToken}`))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function fetchActiveMembership(accessToken: string, org: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "vitehub",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const membership: unknown = await response.json()
    return typeof membership === "object" && membership !== null && "state" in membership && membership.state === "active"
  }
  catch {
    return false
  }
}

/**
 * Returns `true` when the GitHub user of `accessToken` is an active member of `org`. The token needs the `read:org` scope.
 * A pending invitation, a non-2xx response, a network error, or a timeout returns `false`.
 */
export async function isGitHubOrgMember(accessToken: string | null | undefined, org: string, options: GitHubOrgMemberOptions = {}): Promise<boolean> {
  if (!accessToken || !org) return false
  const cacheMs = options.cacheMs ?? 0
  if (cacheMs <= 0) return await fetchActiveMembership(accessToken, org, options.timeoutMs ?? 5000)
  const key = await cacheKey(accessToken, org)
  if ((activeUntil.get(key) ?? 0) > Date.now()) return true
  const member = await fetchActiveMembership(accessToken, org, options.timeoutMs ?? 5000)
  if (member) {
    // A long-lived server would otherwise keep a key for every token it checked.
    const now = Date.now()
    for (const [entry, until] of activeUntil) if (until <= now) activeUntil.delete(entry)
    activeUntil.set(key, now + cacheMs)
  }
  return member
}
