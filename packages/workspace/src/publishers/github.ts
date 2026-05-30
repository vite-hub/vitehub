import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"

import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, normalizeWorkspacePath, sha256 } from "../core/path.ts"

import type {
  PublishContext,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspacePublisher,
} from "../core/types.ts"

export type GitHubPublisherOption = string | (() => string | undefined)

export interface GitHubPublisherOptions {
  branch?: GitHubPublisherOption
  message?: GitHubPublisherOption
  repo?: GitHubPublisherOption
  repository?: GitHubPublisherOption
  root?: GitHubPublisherOption
  token?: GitHubPublisherOption
}

interface GitHubPublisherFile extends WorkspaceFile {
  fullPath: string
}

interface GitHubPublishState {
  files: string[]
}

function processEnv(...keys: string[]): string | undefined {
  const env = typeof process !== "undefined" ? process.env : undefined
  return keys.map(key => env?.[key]).find(value => typeof value === "string" && value.length > 0)
}

function resolveOption(value: GitHubPublisherOption | undefined): string | undefined {
  return typeof value === "function" ? value() : value
}

function requireOption(label: string, value: string | undefined): string {
  if (!value) throw new WorkspaceError(`[vitehub] GitHub workspace publisher requires ${label}.`)
  return value
}

function splitRepository(repository: string) {
  const [owner, repo] = repository.split("/")
  if (!owner || !repo) {
    throw new WorkspaceError("[vitehub] GitHub workspace publisher requires a repository in owner/repo format.")
  }
  return { owner, repo }
}

function joinGitPath(...parts: string[]) {
  return parts.join("/").replaceAll("\\", "/").split("/").filter(Boolean).join("/")
}

function isFileEntry(entry: WorkspaceEntry): entry is WorkspaceEntry & { type: "file" } {
  return entry.type === "file"
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  const encode = (globalThis as { btoa?: (input: string) => string }).btoa
  return encode ? encode(binary) : Buffer.from(bytes).toString("base64")
}

function resolveRepository(options: GitHubPublisherOptions): string | undefined {
  return resolveOption(options.repository)
    || resolveOption(options.repo)
    || processEnv("WORKSPACE_GITHUB_REPOSITORY", "VITEHUB_WORKSPACE_GITHUB_REPOSITORY", "GITHUB_REPOSITORY")
}

function resolveBranch(options: GitHubPublisherOptions): string {
  return resolveOption(options.branch)
    || processEnv("WORKSPACE_GITHUB_BRANCH", "VITEHUB_WORKSPACE_GITHUB_BRANCH", "GITHUB_BRANCH")
    || "main"
}

function resolveRoot(options: GitHubPublisherOptions, workspaceName: string): string {
  return resolveOption(options.root)
    || processEnv("WORKSPACE_GITHUB_ROOT", "VITEHUB_WORKSPACE_GITHUB_ROOT")
    || `.vitehub/workspaces/${workspaceName}`
}

function resolveToken(options: GitHubPublisherOptions): string | undefined {
  return resolveOption(options.token)
    || getActiveCloudflareBinding<string>("GITHUB_TOKEN")
    || processEnv("WORKSPACE_GITHUB_TOKEN", "VITEHUB_WORKSPACE_GITHUB_TOKEN", "GITHUB_TOKEN")
}

function resolveMessage(options: GitHubPublisherOptions, ctx: PublishContext): string {
  return ctx.snapshot?.name
    || resolveOption(options.message)
    || "chore: update workspace snapshot"
}

async function readFiles(ctx: PublishContext, root: string): Promise<GitHubPublisherFile[]> {
  const entries = await ctx.store.list("", { recursive: true })
  return await Promise.all(entries.filter(isFileEntry).map(async (entry) => {
    const file = await ctx.store.readFile(entry.path)
    if (!file) throw new WorkspaceError(`[vitehub] Workspace file disappeared before GitHub publish: ${entry.path}.`)
    return {
      ...file,
      path: normalizeWorkspacePath(entry.path),
      fullPath: joinGitPath(root, entry.path),
    }
  }))
}

async function requestGitHubJson<T>(repo: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "vitehub-workspace",
      "x-github-api-version": "2022-11-28",
      ...init?.headers,
    },
  })

  if (!response.ok) {
    throw new WorkspaceError(`[vitehub] GitHub workspace publisher request failed for ${repo}: ${response.status} ${response.statusText} ${await response.text().catch(() => "")}`)
  }
  return await response.json() as T
}

function isGitHubPublishState(value: unknown): value is GitHubPublishState {
  return !!value
    && typeof value === "object"
    && Array.isArray((value as GitHubPublishState).files)
    && (value as GitHubPublishState).files.every(file => typeof file === "string")
}

export function github(options: GitHubPublisherOptions = {}): WorkspacePublisher {
  let publishedState: GitHubPublishState | undefined
  return {
    name: "github",
    async publish(ctx) {
      const repository = requireOption("a repository", resolveRepository(options))
      const branch = resolveBranch(options)
      const root = resolveRoot(options, ctx.workspace.name)
      const token = requireOption("a token", resolveToken(options))
      const metaKey = `workspace:publish:github:${await sha256({ branch, repository, root })}`
      const storedValue = await ctx.store.getMeta?.(metaKey)
      const storedState = isGitHubPublishState(storedValue) ? storedValue : undefined
      const previousFiles = storedState?.files || publishedState?.files || []
      const files = await readFiles(ctx, root)
      const nextPaths = new Set(files.map(file => file.path))
      const deletedEntries = previousFiles
        .map(path => normalizeWorkspacePath(path))
        .filter(path => !nextPaths.has(path))
        .map(path => ({ path: joinGitPath(root, path), sha: null }))

      if (!files.length && !deletedEntries.length) return

      const { owner, repo } = splitRepository(repository)
      const refPath = `/repos/${owner}/${repo}/git/ref/heads/${branch}`
      const refsPath = `/repos/${owner}/${repo}/git/refs/heads/${branch}`
      const ref = await requestGitHubJson<{ object: { sha: string } }>(repository, token, refPath)
      const current = await requestGitHubJson<{ tree: { sha: string } }>(repository, token, `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)
      const blobs = await Promise.all(files.map(file => requestGitHubJson<{ sha: string }>(repository, token, `/repos/${owner}/${repo}/git/blobs`, {
        body: JSON.stringify({ content: toBase64(contentToBytes(file.content)), encoding: "base64" }),
        method: "POST",
      })))
      const tree = await requestGitHubJson<{ sha: string }>(repository, token, `/repos/${owner}/${repo}/git/trees`, {
        body: JSON.stringify({
          base_tree: current.tree.sha,
          tree: [
            ...files.map((file, index) => ({
              mode: "100644",
              path: file.fullPath,
              sha: blobs[index]!.sha,
              type: "blob",
            })),
            ...deletedEntries,
          ],
        }),
        method: "POST",
      })
      const commit = await requestGitHubJson<{ sha: string }>(repository, token, `/repos/${owner}/${repo}/git/commits`, {
        body: JSON.stringify({
          message: resolveMessage(options, ctx),
          parents: [ref.object.sha],
          tree: tree.sha,
        }),
        method: "POST",
      })
      await requestGitHubJson(repository, token, refsPath, {
        body: JSON.stringify({ sha: commit.sha }),
        method: "PATCH",
      })

      publishedState = { files: files.map(file => file.path) }
      await ctx.store.setMeta?.(metaKey, publishedState)
    },
  }
}
