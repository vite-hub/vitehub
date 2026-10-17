import { forgeArchive, forgeEnv, forgeErrorStatus, forgeProvider } from "@vite-hub/forge"

import { sourceError } from "../../core/errors.ts"

type GitHubProvider = Awaited<ReturnType<typeof forgeProvider>>

export interface GitHubClient {
  archive: (ref: string, token: string | undefined, signal?: AbortSignal) => Promise<Uint8Array>
  defaultBranch: (token: string | undefined, signal?: AbortSignal) => Promise<string>
  file: (path: string, ref: string, token: string | undefined, signal?: AbortSignal) => Promise<{ content: Uint8Array, sha: string | undefined }>
  /** Undefined for a directory or another path that is not a regular file. */
  metadata: (path: string, ref: string, token: string | undefined, signal?: AbortSignal) => Promise<{ sha: string } | undefined>
  resolveCommit: (ref: string, token: string | undefined, signal?: AbortSignal) => Promise<string>
}

/** The Server Env token: `VITEHUB_GITHUB_TOKEN`, then `FORGES_GITHUB_TOKEN`. */
export function githubEnvToken(): string | undefined {
  const env = globalThis.process?.env
  if (!env) return
  for (const name of forgeEnv.github.token.names) {
    const value = env[name]?.trim()
    if (value) return value
  }
}

/** The HTTP status of the Forge request behind a GitHub Source error. */
export function githubErrorStatus(error: unknown): number | undefined {
  return error instanceof Error ? forgeErrorStatus(error.cause) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub JSON crosses the untrusted HTTP boundary as an unknown value.
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub JSON fields must be validated before they are used.
  return typeof value === "string" && value.length > 0
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

  return {
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
        const file = await request(ref, "content", token, signal, async (client, repoRef) => await client.contents.file(repoRef, path, { ref, signal }))
        if (file.encoding !== "binary") throw malformed(repo, "content")
        return { content: file.content, sha: file.sha }
      }
      catch (error) {
        // contents.file() reads a directory listing as a blob without a sha, and GitHub answers 422.
        if (githubErrorStatus(error) !== 422) throw error
        throw sourceError(`[vitehub] github(${JSON.stringify(repo)}) expected ${JSON.stringify(path)} to be a file, but GitHub returned a directory or another entry type.`, { cause: error })
      }
    },
    async metadata(path, ref, token, signal) {
      // contents.file() cannot tell a directory from a file, so read the contents entry directly.
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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub JSON crosses the untrusted HTTP boundary as an unknown value.
      if (typeof sha !== "string" || !sha) throw malformed(repo, "commit")
      return sha
    },
  }
}
