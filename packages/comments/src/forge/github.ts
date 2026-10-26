import { forgeEnv, githubAppCredentials, readForgeEnv, readGitHubAppPrivateKey } from "@vite-hub/forge"
import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import * as v from "valibot"

/** A GitHub request that failed, with the status and GitHub's message. */
export class GitHubRequestError extends Error {
  override name = "GitHubRequestError"
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface GitHubComment {
  id: string
  nodeId: string
  url: string
}

/** The REST and GraphQL calls that the pull request sync makes, each with the token it is given. */
export interface GitHubClient {
  /** The token of the GitHub App installation on the repository, else `VITEHUB_GITHUB_TOKEN`. */
  appToken(repository: string): Promise<string>
  /** The open pull request whose head is `branch` in the repository itself. */
  findPullRequest(repository: string, branch: string): Promise<number | undefined>
  createComment(token: string, repository: string, pullRequest: number, body: string): Promise<GitHubComment>
  updateComment(token: string, repository: string, id: string, body: string): Promise<void>
  /** Deletes a comment. A comment that is already gone counts as deleted. */
  deleteComment(token: string, repository: string, id: string): Promise<void>
  /** Hides a comment as resolved, or shows it again. */
  minimize(token: string, nodeId: string, minimized: boolean): Promise<void>
}

const commentResponse = v.object({ id: v.number(), node_id: v.string(), html_url: v.string() })
const pullsResponse = v.array(v.object({ number: v.number() }))

/** A Server Env value from the active Cloudflare bindings, else from `process.env`. */
function serverEnv(name: string): unknown {
  return getActiveCloudflareBinding<unknown>(name) ?? globalThis.process?.env?.[name]
}

export function createGitHubClient(options: { apiUrl?: string, fetch?: typeof fetch } = {}): GitHubClient {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "")
  const fetcher = options.fetch ?? globalThis.fetch
  // The pull request of a branch rarely changes, so ask GitHub once per branch for a few minutes.
  const pullRequests = new Map<string, { number: number | undefined, until: number }>()

  async function request(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetcher(`${apiUrl}${path}`, {
      method,
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${token}`,
        "user-agent": "vitehub-comments",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => undefined)
      const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : response.statusText
      throw new GitHubRequestError(response.status, `GitHub ${method} ${path.split("?")[0]} failed with ${response.status}: ${message}`)
    }
    return response.status === 204 ? undefined : await response.json()
  }

  async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<void> {
    const graphqlUrl = apiUrl.endsWith("/api/v3") ? `${apiUrl.slice(0, -3)}graphql` : `${apiUrl}/graphql`
    const response = await fetcher(graphqlUrl, {
      method: "POST",
      headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "user-agent": "vitehub-comments" },
      body: JSON.stringify({ query, variables }),
    })
    const data: unknown = await response.json().catch(() => undefined)
    const errors = data && typeof data === "object" && "errors" in data && Array.isArray(data.errors) ? data.errors : []
    if (!response.ok || errors.length) {
      const message = errors[0] && typeof errors[0] === "object" && "message" in errors[0] ? String(errors[0].message) : response.statusText
      throw new GitHubRequestError(response.status, `GitHub GraphQL failed: ${message}`)
    }
  }

  return {
    async appToken(repository) {
      const env = (name: string) => serverEnv(name)
      const appId = readForgeEnv(forgeEnv.github.appId, env)
      const privateKey = appId ? await readGitHubAppPrivateKey(readForgeEnv(forgeEnv.github.privateKey, env), readForgeEnv(forgeEnv.github.privateKeyPath, env)) : undefined
      if (appId && privateKey) {
        const app = githubAppCredentials({ appId, privateKey, baseUrl: apiUrl, ...(options.fetch ? { fetch: options.fetch } : {}), userAgent: "vitehub-comments" })
        const installation = readForgeEnv(forgeEnv.github.installationId, env) ?? await app.installation(repository)
        return (await app.installationToken(installation)).token
      }
      const token = readForgeEnv(forgeEnv.github.token, env)
      if (token) return token
      throw new GitHubRequestError(401, "Comments needs GitHub credentials to post to pull requests: VITEHUB_GITHUB_APP_ID with VITEHUB_GITHUB_PRIVATE_KEY, or VITEHUB_GITHUB_TOKEN.")
    },
    async findPullRequest(repository, branch) {
      const key = `${repository}\0${branch}`
      const cached = pullRequests.get(key)
      if (cached && cached.until > Date.now()) return cached.number
      const token = await this.appToken(repository)
      const owner = repository.split("/")[0]
      const pulls = v.parse(pullsResponse, await request(token, "GET", `/repos/${repository}/pulls?state=open&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`))
      const number = pulls[0]?.number
      pullRequests.set(key, { number, until: Date.now() + (number ? 5 : 1) * 60_000 })
      return number
    },
    async createComment(token, repository, pullRequest, body) {
      const comment = v.parse(commentResponse, await request(token, "POST", `/repos/${repository}/issues/${pullRequest}/comments`, { body }))
      return { id: String(comment.id), nodeId: comment.node_id, url: comment.html_url }
    },
    async updateComment(token, repository, id, body) {
      await request(token, "PATCH", `/repos/${repository}/issues/comments/${id}`, { body })
    },
    async deleteComment(token, repository, id) {
      try {
        await request(token, "DELETE", `/repos/${repository}/issues/comments/${id}`)
      }
      catch (error) {
        if (!(error instanceof GitHubRequestError && error.status === 404)) throw error
      }
    },
    async minimize(token, nodeId, minimized) {
      await graphql(token, minimized
        ? "mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: RESOLVED }) { clientMutationId } }"
        : "mutation($id: ID!) { unminimizeComment(input: { subjectId: $id }) { clientMutationId } }", { id: nodeId })
    },
  }
}
