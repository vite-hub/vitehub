import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"

import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, normalizeWorkspacePath } from "../core/path.ts"

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
  bytes: Uint8Array
  fullPath: string
  gitSha: string
}

interface GitHubTreeEntry {
  mode?: string
  path: string
  sha?: string | null
  type: string
}

interface GitHubTreeResponse {
  tree: GitHubTreeEntry[]
  truncated?: boolean
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

function workspacePathFromGitPath(path: string, root: string): string | undefined {
  const normalized = joinGitPath(path)
  const normalizedRoot = joinGitPath(root)
  if (!normalizedRoot) return normalizeWorkspacePath(normalized)
  if (!normalized.startsWith(`${normalizedRoot}/`)) return undefined
  return normalizeWorkspacePath(normalized.slice(normalizedRoot.length + 1))
}

function isFileEntry(entry: WorkspaceEntry): entry is WorkspaceEntry & { type: "file" } {
  return entry.type === "file"
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`)
  const input = new Uint8Array(prefix.byteLength + bytes.byteLength)
  input.set(prefix)
  input.set(bytes, prefix.byteLength)
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", input)))
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
    const bytes = contentToBytes(file.content)
    return {
      ...file,
      bytes,
      path: normalizeWorkspacePath(entry.path),
      fullPath: joinGitPath(root, entry.path),
      gitSha: await gitBlobSha(bytes),
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

function findRemoteFiles(tree: GitHubTreeResponse, root: string): Map<string, GitHubTreeEntry> {
  if (tree.truncated) {
    throw new WorkspaceError("[vitehub] GitHub workspace publisher could not compare the remote tree because GitHub returned a truncated tree.")
  }

  const files = new Map<string, GitHubTreeEntry>()
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.sha) continue
    const path = workspacePathFromGitPath(entry.path, root)
    if (path) files.set(path, entry)
  }
  return files
}

export function github(options: GitHubPublisherOptions = {}): WorkspacePublisher {
  return {
    name: "github",
    async publish(ctx) {
      const repository = requireOption("a repository", resolveRepository(options))
      const branch = resolveBranch(options)
      const root = resolveRoot(options, ctx.workspace.name)
      const token = requireOption("a token", resolveToken(options))
      const files = await readFiles(ctx, root)
      const nextPaths = new Set(files.map(file => file.path))

      const { owner, repo } = splitRepository(repository)
      const refPath = `/repos/${owner}/${repo}/git/ref/heads/${branch}`
      const refsPath = `/repos/${owner}/${repo}/git/refs/heads/${branch}`
      const ref = await requestGitHubJson<{ object: { sha: string } }>(repository, token, refPath)
      const current = await requestGitHubJson<{ tree: { sha: string } }>(repository, token, `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)
      const remoteFiles = findRemoteFiles(
        await requestGitHubJson<GitHubTreeResponse>(repository, token, `/repos/${owner}/${repo}/git/trees/${current.tree.sha}?recursive=1`),
        root,
      )
      const changedFiles = files.filter(file => remoteFiles.get(file.path)?.sha !== file.gitSha)
      const deletedEntries = [...remoteFiles]
        .filter(([path]) => !nextPaths.has(path))
        .map(([, entry]) => ({ mode: "100644", path: entry.path, sha: null, type: "blob" }))

      if (!changedFiles.length && !deletedEntries.length) return

      const blobs = await Promise.all(changedFiles.map(file => requestGitHubJson<{ sha: string }>(repository, token, `/repos/${owner}/${repo}/git/blobs`, {
        body: JSON.stringify({ content: toBase64(file.bytes), encoding: "base64" }),
        method: "POST",
      })))
      const tree = await requestGitHubJson<{ sha: string }>(repository, token, `/repos/${owner}/${repo}/git/trees`, {
        body: JSON.stringify({
          base_tree: current.tree.sha,
          tree: [
            ...changedFiles.map((file, index) => ({
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
    },
  }
}
