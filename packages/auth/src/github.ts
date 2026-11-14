import { defineErrors } from "@vite-hub/runtime"
import { isRecord } from "@vite-hub/internal/object"

import type { Result } from "@vite-hub/runtime"

export interface GitHubOrgMemberOptions {
  /** Reuse a successful check no older than this many milliseconds per token and organization. Default: no cache. */
  cacheMs?: number
  /** Give up on the GitHub request after this many milliseconds. Default: 5000. */
  timeoutMs?: number
}

/** Why `checkGitHubOrgMember()` could not confirm an active membership. */
export type GitHubOrgMemberErrorCode =
  | "AUTH_GITHUB_NOT_ORG_MEMBER"
  | "AUTH_GITHUB_ORG_ACCESS_DENIED"
  | "AUTH_GITHUB_TOKEN_INVALID"
  | "AUTH_GITHUB_UNAVAILABLE"

// Keep published codes stable. The docs build writes a page for each code.
const githubErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/auth/diagnostics",
  codes: {
    // Config error. `checkGitHubOrgMember()` throws it, because the code must change.
    AUTH_GITHUB_ORG_REQUIRED: {
      why: "`checkGitHubOrgMember()` got an empty organization login.",
      fix: "Pass the login of the organization, for example `checkGitHubOrgMember(token, \"acme\")`.",
    },

    // Runtime errors. `checkGitHubOrgMember()` returns them as `[error, undefined]`.
    AUTH_GITHUB_NOT_ORG_MEMBER: {
      why: ({ org }: { org: string }) => `The GitHub user is not an active member of \`${org}\`, or the invitation is still pending.`,
      fix: "Deny access. Invite the user to the organization, or ask them to accept the pending invitation.",
    },
    AUTH_GITHUB_ORG_ACCESS_DENIED: {
      why: ({ org, sso }: { org: string, sso: boolean }) => sso
        ? `\`${org}\` uses SAML single sign-on, and the token is not authorized for it.`
        : `The token cannot read the memberships of \`${org}\`. It needs the \`read:org\` scope, and the organization must allow the OAuth app.`,
      fix: "Ask the user to sign in with GitHub again with the `read:org` scope, and to authorize the organization's single sign-on when GitHub asks.",
    },
    AUTH_GITHUB_TOKEN_INVALID: {
      why: "GitHub rejected the access token, or there is none. It expired or was revoked.",
      fix: "Ask the user to sign in with GitHub again.",
    },
    AUTH_GITHUB_UNAVAILABLE: {
      why: ({ status }: { status?: number }) => status === undefined
        ? "GitHub did not answer the membership check in time, or the request failed."
        : `GitHub answered the membership check with HTTP ${status}. It is down or rate limited the token.`,
      fix: "Deny access for now and ask the user to try again later. Read `error.cause` for a network error.",
    },
  },
})

// Keys are SHA-256 digests, so the cache never holds a token.
const activeMemberships = new Map<string, { checkedAt: number, expiresAt: number }>()

async function cacheKey(accessToken: string, org: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${org.toLowerCase()}\n${accessToken}`))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

const orgScopes = new Set(["admin:org", "read:org", "write:org"])

async function fetchActiveMembership(accessToken: string, org: string, timeoutMs: number): Promise<Result<void, GitHubOrgMemberErrorCode>> {
  let response: Response
  try {
    response = await fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "vitehub",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (cause) {
    return [githubErrors.AUTH_GITHUB_UNAVAILABLE({ cause }), undefined]
  }
  const { headers, status } = response
  if (status === 401) return [githubErrors.AUTH_GITHUB_TOKEN_INVALID(), undefined]
  // GitHub answers a rate-limited request with 403 or 429.
  if (status === 429 || status >= 500 || (!response.ok && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after")))) {
    return [githubErrors.AUTH_GITHUB_UNAVAILABLE({ status }), undefined]
  }
  if (status === 403) {
    // A secondary rate limit can answer 403 without rate-limit headers. Only its body says so.
    const body: unknown = await response.json().catch(() => undefined)
    if (isRecord(body) && /rate.limit/i.test(`${body.message} ${body.documentation_url}`)) return [githubErrors.AUTH_GITHUB_UNAVAILABLE({ status }), undefined]
    return [githubErrors.AUTH_GITHUB_ORG_ACCESS_DENIED({ org, sso: headers.has("x-github-sso") }), undefined]
  }
  if (status === 404) {
    // Without an org scope, GitHub answers 404 as for a non-member. Only classic OAuth tokens list their scopes.
    const scopes = headers.get("x-oauth-scopes")?.split(/[\s,]+/)
    return scopes && !scopes.some(scope => orgScopes.has(scope))
      ? [githubErrors.AUTH_GITHUB_ORG_ACCESS_DENIED({ org, sso: false }), undefined]
      : [githubErrors.AUTH_GITHUB_NOT_ORG_MEMBER({ org }), undefined]
  }
  if (!response.ok) return [githubErrors.AUTH_GITHUB_UNAVAILABLE({ status }), undefined]
  let membership: unknown
  try {
    membership = await response.json()
  }
  catch (cause) {
    return [githubErrors.AUTH_GITHUB_UNAVAILABLE({ cause, status }), undefined]
  }
  if (typeof membership !== "object" || membership === null || !("state" in membership)) {
    return [githubErrors.AUTH_GITHUB_UNAVAILABLE({ status }), undefined]
  }
  return membership.state === "active" ? [undefined, undefined] : [githubErrors.AUTH_GITHUB_NOT_ORG_MEMBER({ org }), undefined]
}

/**
 * Checks that the GitHub user of `accessToken` is an active member of `org`. The token needs the `read:org` scope.
 * Returns `[undefined, undefined]` for an active membership, else the error that says why it could not confirm one.
 */
export async function checkGitHubOrgMember(accessToken: string | null | undefined, org: string, options: GitHubOrgMemberOptions = {}): Promise<Result<void, GitHubOrgMemberErrorCode>> {
  if (!org) throw githubErrors.AUTH_GITHUB_ORG_REQUIRED()
  if (!accessToken) return [githubErrors.AUTH_GITHUB_TOKEN_INVALID(), undefined]
  const cacheMs = options.cacheMs ?? 0
  if (cacheMs <= 0) return await fetchActiveMembership(accessToken, org, options.timeoutMs ?? 5000)
  const key = await cacheKey(accessToken, org)
  const cached = activeMemberships.get(key)
  if (cached && cached.checkedAt + cacheMs > Date.now()) return [undefined, undefined]
  const result = await fetchActiveMembership(accessToken, org, options.timeoutMs ?? 5000)
  if (!result[0]) {
    // A long-lived server would otherwise keep a key for every token it checked.
    const now = Date.now()
    for (const [entry, membership] of activeMemberships) if (membership.expiresAt <= now) activeMemberships.delete(entry)
    activeMemberships.set(key, { checkedAt: now, expiresAt: now + cacheMs })
  }
  return result
}

/**
 * Returns `true` when the GitHub user of `accessToken` is an active member of `org`. The token needs the `read:org` scope.
 * Every failure returns `false`. Use `checkGitHubOrgMember()` to know why.
 */
export async function isGitHubOrgMember(accessToken: string | null | undefined, org: string, options: GitHubOrgMemberOptions = {}): Promise<boolean> {
  if (!org) return false
  const [error] = await checkGitHubOrgMember(accessToken, org, options)
  return !error
}
