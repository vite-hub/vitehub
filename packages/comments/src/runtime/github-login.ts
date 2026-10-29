import { hkdfSync } from "node:crypto"

import { defineAuth } from "@vite-hub/auth"
import { stateless } from "@vite-hub/auth/presets"
import { createAuthForRequest } from "@vite-hub/auth/server"
import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { readViteHubSecret, viteHubSecretMinimumLength, viteHubSecretSalt } from "@vite-hub/internal/secret"
import * as v from "valibot"

import { forgetGitHubToken, rememberGitHubToken } from "../forge/tokens.ts"
import { commentsRoute } from "../page.ts"
import { requestOf } from "./request.ts"

import type { H3Event } from "h3"
import type { CommentsGitHubAccess, CommentsUser } from "../types.ts"

/** The Server Env names of the OAuth client that people sign in to Comments with: a GitHub App's, or an OAuth App's. */
export const githubLoginEnv = { clientId: "VITEHUB_GITHUB_CLIENT_ID", clientSecret: "VITEHUB_GITHUB_CLIENT_SECRET" } as const

/** Where Better Auth serves the GitHub sign-in of Comments. */
export const githubLoginPath: string = `${commentsRoute}/auth`

/** How long a sign-in lasts. The session is in an encrypted cookie, so it cannot be revoked before then. */
const sessionLifetime = "7d"

/** How long Comments trusts the repository access that GitHub reported for a person. */
const accessLifetime = 5 * 60_000

const userResponse = v.object({ login: v.string() })
const repositoryResponse = v.object({ permissions: v.optional(v.object({ push: v.optional(v.boolean()) })) })

type BetterAuth = ReturnType<typeof createAuthForRequest>

export interface CommentsGitHubLogin {
  /** Whether the server has the OAuth client, so the overlay offers **Sign in with GitHub**. */
  configured(): boolean
  /** The person signed in with GitHub, with what they may do in the repository. Null without a session. */
  user(event: H3Event): Promise<CommentsUser | null>
  /** The sign-in, callback, and sign-out routes under `/api/_vitehub/comments/auth/`. */
  handle(event: H3Event, path: string): Promise<Response>
}

function serverEnv(name: string): string | undefined {
  const value: unknown = getActiveCloudflareBinding<unknown>(name) ?? globalThis.process?.env?.[name]
  return typeof value === "string" && value ? value : undefined
}

/**
 * The secret of the session cookies: derived from `VITEHUB_SECRET` for Comments alone, so the app's own Auth cookies
 * and these never open each other. Without a root secret, Better Auth uses its development secret, and fails in
 * production.
 */
function sessionSecret(): string | undefined {
  const root = readViteHubSecret({ VITEHUB_SECRET: serverEnv("VITEHUB_SECRET"), NUXT_APP_SECRET: serverEnv("NUXT_APP_SECRET") })
  if (!root) return
  if (root.length < viteHubSecretMinimumLength) {
    throw new TypeError(`[vitehub] VITEHUB_SECRET must be at least ${viteHubSecretMinimumLength} characters. Generate one with \`openssl rand -base64 32\`.`)
  }
  const bytes = new Uint8Array(hkdfSync("sha256", root, viteHubSecretSalt, "vitehub:comments:auth", 32))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

/** A return path on this site, so the sign-in cannot send people elsewhere. */
export function safeReturn(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/?comments"
}

/**
 * Sign in with GitHub for Comments, with no database: ViteHub Auth's `stateless()` preset keeps the session, and the
 * GitHub token, in encrypted cookies. A person may comment when GitHub says they can push to the repository of the
 * build.
 */
export function createCommentsGitHubLogin(options: { repository?: string, apiUrl?: string, fetch?: typeof fetch, basePath?: string } = {}): CommentsGitHubLogin {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "")
  const fetcher = options.fetch ?? globalThis.fetch
  const instances = new Map<string, BetterAuth>()
  const access = new Map<string, CommentsGitHubAccess & { until: number }>()

  function auth(event: H3Event, request: Request): BetterAuth {
    const clientId = serverEnv(githubLoginEnv.clientId)!
    const clientSecret = serverEnv(githubLoginEnv.clientSecret)!
    const secret = sessionSecret()
    const origin = forwardedRequestOrigin(request)
    const key = [origin, clientId, clientSecret, secret].join("\0")
    let instance = instances.get(key)
    if (!instance) {
      const definition = defineAuth(() => ({
        baseURL: origin,
        basePath: options.basePath ?? githubLoginPath,
        ...(secret ? { secret } : {}),
        preset: stateless({ maxAge: sessionLifetime }),
        socialProviders: {
          github: {
            clientId,
            clientSecret,
            // Better Auth needs an email, and GitHub hides it unless the App may read email addresses. GitHub's own
            // noreply address keeps sign-in working without that permission.
            mapProfileToUser: (profile: { id: string | number, login: string, email?: string | null }) => profile.email ? {} : { email: `${profile.id}+${profile.login}@users.noreply.github.com` },
          },
        },
        // The app's own Auth may use Better Auth's default cookie names.
        advanced: { cookiePrefix: "vitehub_comments" },
      }))
      instance = createAuthForRequest(definition, request, undefined, event)
      if (instances.size > 20) instances.clear()
      instances.set(key, instance)
    }
    return instance
  }

  async function github(token: string, path: string): Promise<unknown> {
    const response = await fetcher(`${apiUrl}${path}`, {
      headers: { "accept": "application/vnd.github+json", "authorization": `Bearer ${token}`, "user-agent": "vitehub-comments", "x-github-api-version": "2022-11-28" },
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`GitHub GET ${path} failed with ${response.status}`)
    return await response.json()
  }

  /** The GitHub login of a person, and whether they can push to the repository. */
  async function accessOf(userId: string, token: string): Promise<CommentsGitHubAccess> {
    const key = `${userId}\0${options.repository ?? ""}`
    const cached = access.get(key)
    if (cached && cached.until > Date.now()) return { login: cached.login, ...(cached.repository ? { repository: cached.repository } : {}), write: cached.write }
    const [user, repository] = await Promise.all([
      github(token, "/user"),
      options.repository ? github(token, `/repos/${options.repository}`) : undefined,
    ])
    const login = v.parse(userResponse, user).login
    // GitHub answers 404 for a private repository that the person cannot see.
    const write = repository === undefined ? false : v.parse(repositoryResponse, repository).permissions?.push === true
    const result: CommentsGitHubAccess = { login, ...(options.repository ? { repository: options.repository } : {}), write }
    if (access.size > 1000) access.clear()
    access.set(key, { ...result, until: Date.now() + accessLifetime })
    return result
  }

  const configured = (): boolean => Boolean(serverEnv(githubLoginEnv.clientId) && serverEnv(githubLoginEnv.clientSecret))

  return {
    configured,
    async user(event) {
      if (!configured()) return null
      const request = requestOf(event)
      const instance = auth(event, request)
      const session = await instance.api.getSession({ headers: request.headers })
      const user: unknown = session?.user
      if (!user || typeof user !== "object" || !("id" in user) || typeof user.id !== "string") return null
      // The GitHub token is in the account cookie of the session. Without it, Comments cannot check the repository.
      const accessToken = await instance.api.getAccessToken({ body: { useAccountCookie: true }, headers: request.headers })
        .then(tokens => tokens.accessToken, () => undefined)
      if (!accessToken) return null
      const githubAccess = await accessOf(user.id, accessToken)
      rememberGitHubToken(user.id, accessToken)
      const name = "name" in user && typeof user.name === "string" && user.name ? user.name : githubAccess.login
      return { ...user, id: user.id, name, github: githubAccess }
    },
    async handle(event, path) {
      if (!configured()) {
        return Response.json({ error: { code: "COMMENTS_SIGN_IN_OFF", why: "This site has no GitHub sign-in for Comments.", fix: `Set ${githubLoginEnv.clientId} and ${githubLoginEnv.clientSecret} on the server.` } }, { status: 404 })
      }
      const request = requestOf(event)
      const instance = auth(event, request)
      const url = new URL(request.url)
      // Starts the GitHub sign-in, then comes back to the page with comment mode on.
      if (path === "/auth/github" && request.method === "GET") {
        const response = await instance.api.signInSocial({ body: { provider: "github", callbackURL: safeReturn(url.searchParams.get("return")), disableRedirect: true }, headers: request.headers, asResponse: true })
        const body: unknown = await response.json().catch(() => undefined)
        const target = body && typeof body === "object" && "url" in body && typeof body.url === "string" ? body.url : undefined
        if (!target) return Response.json({ error: { code: "COMMENTS_SIGN_IN_FAILED", why: "GitHub sign-in could not start." } }, { status: 502 })
        const headers = new Headers({ "location": target, "cache-control": "no-store" })
        for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie)
        return new Response(null, { status: 302, headers })
      }
      if (path === "/auth/sign-out") {
        const session = await instance.api.getSession({ headers: request.headers }).catch(() => null)
        if (session?.user.id) forgetGitHubToken(session.user.id)
      }
      return await instance.handler(request)
    },
  }
}
