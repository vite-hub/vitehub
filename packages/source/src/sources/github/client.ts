import { forgeArchive, forgeEnv, forgeErrorStatus, forgeProvider, readForgeEnv } from "@vite-hub/forge"

import { sourceError } from "../../core/errors.ts"
import { isRecord } from "@vite-hub/internal/object"

import type { GitHubPullRequest } from "./types.ts"

type GitHubProvider = Awaited<ReturnType<typeof forgeProvider>>

export interface GitHubClient {
  /** The head commit of a branch, or undefined when the repository has no branch with this full name. */
  branch: (name: string, token: string | undefined, signal?: AbortSignal) => Promise<string | undefined>
  /** The full SHA of a commit, or undefined when the repository has no such commit. */
  commit: (sha: string, token: string | undefined, signal?: AbortSignal) => Promise<string | undefined>
  /** A pull request and its head commit, or undefined when the repository has no such pull request. */
  pull: (number: number, token: string | undefined, signal?: AbortSignal) => Promise<{ sha: string, pull: GitHubPullRequest } | undefined>
  /** How `head` relates to `base`: `behind` or `identical` when `base` contains it. Undefined when they share no history. */
  compare: (base: string, head: string, token: string | undefined, signal?: AbortSignal) => Promise<"identical" | "behind" | "ahead" | "diverged" | undefined>
  /** The pull requests that contain a commit, with their head commits. Empty when the repository has no such commit. */
  commitPulls: (sha: string, token: string | undefined, signal?: AbortSignal) => Promise<Array<{ sha: string, pull: GitHubPullRequest }>>
  /** The 100 most recently updated open pull requests, with their head commits. GitHub lists fork pull requests here too. */
  openPulls: (token: string | undefined, signal?: AbortSignal) => Promise<Array<{ sha: string, pull: GitHubPullRequest }>>
  archive: (ref: string, token: string | undefined, signal?: AbortSignal) => Promise<Uint8Array>
  defaultBranch: (token: string | undefined, signal?: AbortSignal) => Promise<string>
  file: (path: string, ref: string, token: string | undefined, signal?: AbortSignal) => Promise<{ content: Uint8Array, sha: string | undefined }>
  /** Undefined for a directory or another path that is not a regular file. */
  metadata: (path: string, ref: string, token: string | undefined, signal?: AbortSignal) => Promise<{ sha: string } | undefined>
  resolveCommit: (ref: string, token: string | undefined, signal?: AbortSignal) => Promise<string>
}

/** The Server Env token: `VITEHUB_GITHUB_TOKEN`, then `FORGES_GITHUB_TOKEN`. */
export function githubEnvToken(): string | undefined {
  return readForgeEnv(forgeEnv.github.token)
}

/** The HTTP status of the Forge request behind a GitHub Source error. */
export function githubErrorStatus(error: unknown): number | undefined {
  return error instanceof Error ? forgeErrorStatus(error.cause) : undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Undefined when GitHub answers that the ref does not exist: 404, or 422 for an unknown commit SHA. */
async function missingAsUndefined<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load()
  }
  catch (error) {
    const status = githubErrorStatus(error)
    if (status === 404 || status === 422) return
    throw error
  }
}

function malformed(repo: string, description: string): Error {
  return sourceError(`[vitehub] github(${JSON.stringify(repo)}) returned a malformed ${description} response.`)
}

export function createGitHubClient(repo: string): GitHubClient {
  const [owner, name, ...rest] = repo.split("/")
  let cached: { provider: Promise<GitHubProvider>, token: string | undefined } | undefined

  function provider(token: string | undefined) {
    if (!cached || cached.token !== token) {
      cached = { provider: forgeProvider({ forge: "github", readOnly: true, token, userAgent: "vitehub-source" }), token }
    }
    return cached.provider
  }

  async function request<T>(ref: string, description: string, token: string | undefined, signal: AbortSignal | undefined, load: (provider: GitHubProvider, repoRef: Parameters<GitHubProvider["repos"]["get"]>[0]) => Promise<T>): Promise<T> {
    if (!owner || !name || rest.length) {
      throw sourceError(`[vitehub] github(${JSON.stringify(repo)}) supports GitHub.com repositories only and expects repo as "owner/name".`)
    }
    const client = await provider(token)
    try {
      return await load(client, { forge: client.forge, instance: client.instance, name, owner })
    }
    catch (error) {
      if (signal?.aborted) throw error
      const status = forgeErrorStatus(error)
      if (status === undefined) throw error
      if (status === 404) {
        throw sourceError(`[vitehub] github(${JSON.stringify(repo)}) could not access the repository or ref ${JSON.stringify(ref)}. Check that the repo exists, the ref exists, and auth can access it.`, { cause: error })
      }
      throw sourceError(`[vitehub] github(${JSON.stringify(repo)}) ${description} request failed with ${status}.`, { cause: error })
    }
  }

  function repoPath(repoRef: { owner: string, name: string }): string {
    return `/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.name)}`
  }

  function repoName(value: unknown): string | null {
    return isRecord(value) && isNonEmptyString(value.full_name) ? value.full_name : null
  }

  /** A pull request from `/pulls/<number>` or `/commits/<sha>/pulls`. The list has `merged_at` but no `merged`. */
  function pullRequest(data: unknown, number: number): { sha: string, pull: GitHubPullRequest } {
    if (!isRecord(data) || !Number.isSafeInteger(number) || !isRecord(data.head) || !isRecord(data.base) || !isNonEmptyString(data.head.sha) || !isNonEmptyString(data.head.ref) || !isNonEmptyString(data.base.ref)) {
      throw malformed(repo, "pull request")
    }
    const headRepo = repoName(data.head.repo)
    const baseRepo = repoName(data.base.repo) ?? repo
    const labels = Array.isArray(data.labels) ? data.labels.flatMap(label => isRecord(label) && isNonEmptyString(label.name) ? [label.name] : []) : []
    return {
      sha: data.head.sha,
      pull: {
        number,
        state: data.state === "open" ? "open" : "closed",
        merged: data.merged === true || isNonEmptyString(data.merged_at),
        head: data.head.ref,
        headRepo,
        base: data.base.ref,
        fork: headRepo?.toLowerCase() !== baseRepo.toLowerCase(),
        labels,
      },
    }
  }

  return {
    async branch(branch, token, signal) {
      const data = await missingAsUndefined(() => request(branch, "branch", token, signal, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `${repoPath(repoRef)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
        { signal },
      )).data))
      if (data === undefined) return
      // An older API answered a partial name with the list of branches that start with it. Only an exact match counts.
      if (Array.isArray(data)) return
      if (!isRecord(data) || !isRecord(data.object) || !isNonEmptyString(data.object.sha)) throw malformed(repo, "branch")
      return data.object.sha
    },
    async commit(sha, token, signal) {
      // contents.resolveRef() returns a full SHA without a request, so read the commit to know that it exists.
      const data = await missingAsUndefined(() => request(sha, "commit", token, signal, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `${repoPath(repoRef)}/commits/${encodeURIComponent(sha)}`,
        { signal },
      )).data))
      if (data === undefined) return
      if (!isRecord(data) || !isNonEmptyString(data.sha)) throw malformed(repo, "commit")
      return data.sha
    },
    async pull(number, token, signal) {
      const data = await missingAsUndefined(() => request(`pull/${number}`, "pull request", token, signal, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `${repoPath(repoRef)}/pulls/${number}`,
        { signal },
      )).data))
      if (data === undefined) return
      return pullRequest(data, number)
    },
    async compare(base, head, token, signal) {
      const data = await missingAsUndefined(() => request(`${base}...${head}`, "compare", token, signal, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `${repoPath(repoRef)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        { signal },
      )).data))
      if (data === undefined) return
      if (!isRecord(data) || (data.status !== "identical" && data.status !== "behind" && data.status !== "ahead" && data.status !== "diverged")) throw malformed(repo, "compare")
      return data.status
    },
    async commitPulls(sha, token, signal) {
      const data = await missingAsUndefined(() => request(sha, "commit pull requests", token, signal, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `${repoPath(repoRef)}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`,
        { signal },
      )).data))
      if (data === undefined) return []
      if (!Array.isArray(data)) throw malformed(repo, "commit pull requests")
      return data.map(item => pullRequest(item, isRecord(item) && typeof item.number === "number" ? item.number : Number.NaN))
    },
    async openPulls(token, signal) {
      const data = await request("open", "pull requests", token, signal, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `${repoPath(repoRef)}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
        { signal },
      )).data)
      if (!Array.isArray(data)) throw malformed(repo, "pull requests")
      return data.map(item => pullRequest(item, isRecord(item) && typeof item.number === "number" ? item.number : Number.NaN))
    },
    async archive(ref, token, signal) {
      const download = (archiveToken: string | undefined) => request(ref, "archive", archiveToken, signal, async (client, repoRef) => {
        const stream = await forgeArchive(client, repoRef, { ref, signal })
        return new Uint8Array(await new Response(stream).arrayBuffer())
      })
      try {
        return await download(token)
      }
      catch (error) {
        // An authenticated archive uses the API limit. A public repository is still on codeload without a token.
        const status = githubErrorStatus(error)
        if (!token || (status !== 403 && status !== 429)) throw error
        return await download(undefined)
      }
    },
    async defaultBranch(token, signal) {
      const branch = await request("default", "repository", token, signal, async (client, repoRef) => (await client.repos.get(repoRef, { signal })).defaultBranch)
      if (!branch) throw malformed(repo, "repository")
      return branch
    },
    async file(path, ref, token, signal) {
      try {
        const file = await request(ref, "content", token, signal, async (client, repoRef) => await client.contents.getFile(repoRef, path, { ref, signal }))
        if (file.encoding !== "binary") throw malformed(repo, "content")
        return { content: file.content, sha: file.sha }
      }
      catch (error) {
        // contents.getFile() reads a directory listing as a blob without a sha, and GitHub answers 422.
        if (githubErrorStatus(error) !== 422) throw error
        throw sourceError(`[vitehub] github(${JSON.stringify(repo)}) expected ${JSON.stringify(path)} to be a file, but GitHub returned a directory or another entry type.`, { cause: error })
      }
    },
    async metadata(path, ref, token, signal) {
      // contents.getFile() cannot tell a directory from a file, so read the contents entry directly.
      const entry = await request(ref, "content", token, signal, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.name)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
        { query: { ref }, signal },
      )).data)
      if (Array.isArray(entry)) return
      if (!isRecord(entry) || !isNonEmptyString(entry.type) || !isNonEmptyString(entry.sha)) throw malformed(repo, "content")
      return entry.type === "file" ? { sha: entry.sha } : undefined
    },
    async resolveCommit(ref, token, signal) {
      const sha: unknown = await request(ref, "commit", token, signal, async (client, repoRef) => await client.contents.resolveRef(repoRef, ref, { signal }))
      if (typeof sha !== "string" || !sha) throw malformed(repo, "commit")
      return sha
    },
  }
}
