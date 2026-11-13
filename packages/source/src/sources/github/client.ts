import { forgeArchive, forgeEnv, forgeErrorStatus, forgeProvider, readForgeEnv } from "@vite-hub/forge"

import { sourceError } from "../../core/errors.ts"
import { isRecord } from "@vite-hub/internal/object"

import type { GitHubFileCommit, GitHubHistoryOptions, GitHubPullRequest } from "./types.ts"

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
  /** One page of the commits that changed `path`, newest first, from `sha` back. */
  commits: (path: string, options: GitHubHistoryOptions, token: string | undefined) => Promise<{ commits: GitHubFileCommit[], more: boolean }>
  /** The latest commit that changed each path, from `sha` back, in one GraphQL request. Null for a path without commits. */
  latestCommits: (paths: readonly string[], sha: string, token: string | undefined) => Promise<Array<GitHubFileCommit | null>>
  /**
   * The paths that a commit from `base` to `head` changed, with the old path of a rename, including a file that one
   * commit edits and a later one reverts. One compare request, plus one request per commit when there is more than
   * one. Undefined when `head` is not `base` or a descendant of it, when there are more than 20 commits, or when GitHub
   * lists 300 files, its limit, so the list may be cut.
   */
  changedPaths: (base: string, head: string, token: string | undefined) => Promise<string[] | undefined>
  /**
   * The paths that a pull request adds or changes, without removed files. Undefined when the repository has no such
   * pull request. GitHub lists at most 3,000 files.
   */
  pullPaths: (number: number, token: string | undefined) => Promise<string[] | undefined>
}

/** GitHub lists at most this many files in a compare response. */
const compareFileLimit = 300
/** GitHub lists at most 3,000 files of a pull request, 100 on each page. */
const pullFilePages = 30
/**
 * `changedPaths()` reads the files of each commit between the two commits, up to this many commits. More commits read
 * every page again.
 */
const compareCommitLimit = 20
/** Commit requests of `changedPaths()` that run at once. */
const compareCommitConcurrency = 4

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

function fileCommit(repo: string, item: unknown): GitHubFileCommit {
  const commit: unknown = isRecord(item) ? item.commit : undefined
  const author: unknown = isRecord(commit) ? commit.author : undefined
  const login: unknown = isRecord(item) && isRecord(item.author) ? item.author.login : undefined
  const name: unknown = isRecord(author) ? author.name : undefined
  const date: unknown = isRecord(author) ? author.date : undefined
  const message: unknown = isRecord(commit) ? commit.message : undefined
  if (!isRecord(item) || !isNonEmptyString(item.sha) || !isNonEmptyString(item.html_url) || !isNonEmptyString(date) || typeof message !== "string") {
    throw malformed(repo, "commits")
  }
  return {
    sha: item.sha,
    date: new Date(date).toISOString(),
    author: isNonEmptyString(login) ? login : isNonEmptyString(name) ? name : null,
    message: message.split("\n", 1)[0]!.trim(),
    url: item.html_url,
  }
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
    async commits(path, { sha, page, perPage }, token) {
      const response = await request(sha, "commits", token, undefined, async (client, repoRef) => await client.request<unknown>(
        "GET",
        `/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.name)}/commits`,
        { query: { path, sha, page, per_page: perPage } },
      ))
      if (!Array.isArray(response.data)) throw malformed(repo, "commits")
      return {
        commits: response.data.map(item => fileCommit(repo, item)),
        more: /rel="next"/.test(response.headers.get("link") ?? ""),
      }
    },
    async latestCommits(paths, sha, token) {
      const fields = "oid authoredDate message url author { name user { login } }"
      const query = [
        `query FileHistory($owner: String!, $name: String!, $sha: GitObjectID!${paths.map((_, index) => `, $p${index}: String!`).join("")}) {`,
        "  repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit {",
        ...paths.map((_, index) => `    p${index}: history(first: 1, path: $p${index}) { nodes { ${fields} } }`),
        "  } } }",
        "}",
      ].join("\n")
      const data = await request(sha, "file history", token, undefined, async (client, repoRef) => (await client.request<unknown>("POST", "/graphql", {
        body: { query, operationName: "FileHistory", variables: { owner: repoRef.owner, name: repoRef.name, sha, ...Object.fromEntries(paths.map((path, index) => [`p${index}`, path])) } },
        mutates: false,
      })).data)
      if (!isRecord(data) || (Array.isArray(data.errors) && data.errors.length)) {
        const message: unknown = isRecord(data) && Array.isArray(data.errors) && isRecord(data.errors[0]) ? data.errors[0].message : undefined
        throw sourceError(`[vitehub] github(${JSON.stringify(repo)}) file history request failed${typeof message === "string" ? `: ${message}` : "."}`)
      }
      const commit: unknown = isRecord(data.data) && isRecord(data.data.repository) ? data.data.repository.object : undefined
      if (!isRecord(commit)) throw malformed(repo, "file history")
      return paths.map((_, index) => {
        const history: unknown = commit[`p${index}`]
        const node: unknown = isRecord(history) && Array.isArray(history.nodes) ? history.nodes[0] : undefined
        if (!isRecord(history) || !Array.isArray(history.nodes)) throw malformed(repo, "file history")
        if (node === undefined) return null
        const author: unknown = isRecord(node) ? node.author : undefined
        const login: unknown = isRecord(author) && isRecord(author.user) ? author.user.login : undefined
        const name: unknown = isRecord(author) ? author.name : undefined
        if (!isRecord(node) || !isNonEmptyString(node.oid) || !isNonEmptyString(node.authoredDate) || !isNonEmptyString(node.url) || typeof node.message !== "string") {
          throw malformed(repo, "file history")
        }
        return {
          sha: node.oid,
          date: new Date(node.authoredDate).toISOString(),
          author: isNonEmptyString(login) ? login : isNonEmptyString(name) ? name : null,
          message: node.message.split("\n", 1)[0]!.trim(),
          url: node.url,
        }
      })
    },
    async changedPaths(base, head, token) {
      const data = await missingAsUndefined(() => request(`${base}...${head}`, "compare", token, undefined, async (client, repoRef) => (await client.request<unknown>(
        "GET",
        `${repoPath(repoRef)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        { query: { per_page: compareCommitLimit } },
      )).data))
      if (data === undefined) return
      if (!isRecord(data) || typeof data.status !== "string") throw malformed(repo, "compare")
      if (data.status !== "ahead" && data.status !== "identical") return
      const paths = (files: unknown, what: string): string[] | undefined => {
        if (!Array.isArray(files)) throw malformed(repo, what)
        if (files.length >= compareFileLimit) return
        return files.flatMap((file) => {
          if (!isRecord(file) || !isNonEmptyString(file.filename)) throw malformed(repo, what)
          return isNonEmptyString(file.previous_filename) ? [file.filename, file.previous_filename] : [file.filename]
        })
      }
      const changed = paths(data.files ?? [], "compare")
      if (!changed) return
      // The compare files are the net change, so a file that a commit edits and a later one reverts is not in them.
      // With more than one commit, the files of each commit name every file that a commit touched.
      const commits: unknown = data.commits ?? []
      const total: unknown = data.total_commits ?? 0
      if (!Array.isArray(commits) || typeof total !== "number") throw malformed(repo, "compare")
      if (total <= 1) return changed
      if (total > compareCommitLimit || commits.length < total) return
      const touched = new Set(changed)
      for (let start = 0; start < commits.length; start += compareCommitConcurrency) {
        const lists = await Promise.all(commits.slice(start, start + compareCommitConcurrency).map(async (commit: unknown) => {
          if (!isRecord(commit) || !isNonEmptyString(commit.sha)) throw malformed(repo, "compare")
          const sha = commit.sha
          const detail = await request(sha, "commit", token, undefined, async (client, repoRef) => (await client.request<unknown>(
            "GET",
            `${repoPath(repoRef)}/commits/${encodeURIComponent(sha)}`,
            { query: { per_page: compareFileLimit } },
          )).data)
          if (!isRecord(detail)) throw malformed(repo, "commit")
          return paths(detail.files ?? [], "commit")
        }))
        for (const list of lists) {
          if (!list) return
          for (const path of list) touched.add(path)
        }
      }
      return [...touched]
    },
    async pullPaths(number, token) {
      const paths: string[] = []
      for (let page = 1; page <= pullFilePages; page++) {
        const data = await missingAsUndefined(() => request(`pull/${number}`, "pull request files", token, undefined, async (client, repoRef) => (await client.request<unknown>(
          "GET",
          `${repoPath(repoRef)}/pulls/${number}/files`,
          { query: { per_page: 100, page } },
        )).data))
        if (data === undefined) return
        if (!Array.isArray(data)) throw malformed(repo, "pull request files")
        for (const file of data) {
          if (!isRecord(file) || !isNonEmptyString(file.filename) || !isNonEmptyString(file.status)) throw malformed(repo, "pull request files")
          if (file.status !== "removed") paths.push(file.filename)
        }
        if (data.length < 100) break
      }
      return paths
    },
    async resolveCommit(ref, token, signal) {
      const sha: unknown = await request(ref, "commit", token, signal, async (client, repoRef) => await client.contents.resolveRef(repoRef, ref, { signal }))
      if (typeof sha !== "string" || !sha) throw malformed(repo, "commit")
      return sha
    },
  }
}
