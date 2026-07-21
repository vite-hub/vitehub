import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"

import { WorkspaceError } from "../../core/errors.ts"
import { contentToBytes, matchesAny, normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern, normalizeWorkspacePath, sha256 } from "../../core/path.ts"
import { MemoryFS } from "../../storage/memory-fs.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../../storage/utils.ts"

import type {
  CloudflareArtifactsWorkspaceStoreOptions,
  DiffOptions,
  GlobOptions,
  ListOptions,
  MkdirOptions,
  RmOptions,
  SnapshotOptions,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSnapshot,
  WorkspaceStat,
  WorkspaceStore,
} from "../../core/types.ts"

interface DisposableRpcValue {
  [Symbol.dispose]?: () => void
}

interface ArtifactsCreateTokenResult extends DisposableRpcValue {
  expiresAt: string
  plaintext: string
}

interface ArtifactsRepoInfo extends DisposableRpcValue {
  defaultBranch: string
  remote: string
}

interface ArtifactsCreateRepoResult extends ArtifactsRepoInfo {
  name: string
  token: string
}

interface ArtifactsRepo extends DisposableRpcValue {
  createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsCreateTokenResult>
  info(): Promise<ArtifactsRepoInfo>
}

interface ArtifactsBinding {
  create(name: string, options?: { description?: string, readOnly?: boolean, setDefaultBranch?: string }): Promise<ArtifactsCreateRepoResult>
  get(name: string): Promise<ArtifactsRepo>
}

const dir = "/workspace"
const fileMetadataPath = ".vitehub/files.json"
const tokenRefreshWindow = 60_000

type FileMetadata = Pick<WorkspaceFile, "mediaType" | "metadata">

function tokenSecret(token: string) {
  return token.split("?expires=")[0] || token
}

function tokenExpiresAt(token: string) {
  const expires = token.match(/[?&]expires=(\d+)(?:&|$)/)?.[1]
  return expires ? Number(expires) * 1000 : 0
}

function disposeRpc(value: DisposableRpcValue | undefined) {
  value?.[Symbol.dispose]?.()
}

function encodeWorkspaceRepoName(workspaceName: string) {
  let encoded = ""
  for (const byte of new TextEncoder().encode(workspaceName)) {
    const character = String.fromCharCode(byte)
    if (/[a-zA-Z0-9.-]/.test(character)) encoded += character
    else if (character === "_") encoded += "__"
    else encoded += `_${byte.toString(16).padStart(2, "0")}`
  }
  return encoded
}

function repoName(options: CloudflareArtifactsWorkspaceStoreOptions, workspaceName: string) {
  return options.repo || `${options.repoPrefix || "vitehub-workspace-"}${encodeWorkspaceRepoName(workspaceName)}`
}

function hasArtifactsErrorCode(error: unknown, code: string, numericCode: number) {
  if (typeof error !== "object" || !error) return false
  const value = error as { code?: number | string, numericCode?: number }
  return value.code === code || value.numericCode === numericCode || value.code === numericCode
}

function isNonFastForward(error: unknown) {
  if (typeof error !== "object" || !error) return false
  const value = error as {
    code?: string
    data?: { prettyDetails?: string, reason?: string, result?: unknown }
    message?: string
  }
  if (value.code === "PushRejectedError" && value.data?.reason === "not-fast-forward") return true
  if (value.code !== "GitPushError") return false
  return /non-fast-forward|fetch first|stale info/i.test([
    value.message,
    value.data?.prettyDetails,
    JSON.stringify(value.data?.result),
  ].filter(Boolean).join(" "))
}

class CloudflareArtifactsWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined
  #branch = "main"
  #files = new Map<string, FileMetadata>()
  #fs: MemoryFS | undefined
  #head: string | undefined
  #pendingCommit: string | undefined
  #remote: string | undefined
  #ready: Promise<void> | undefined
  #mutationQueue: Promise<void> = Promise.resolve()
  #token: { expiresAt: number, value: string } | undefined

  constructor(private options: CloudflareArtifactsWorkspaceStoreOptions, private workspaceName: string) {}

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    const filepath = this.#absolute(normalized)
    const content = await this.#fs!.promises.readFile(filepath).catch(() => undefined)
    if (!content) return undefined
    const fileMetadata = this.#files.get(normalized)
    return {
      path: normalized,
      content: content as Uint8Array,
      mediaType: fileMetadata?.mediaType,
      metadata: fileMetadata?.metadata,
    }
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    await this.#mutate(async () => {
      await this.#fs!.promises.writeFile(this.#absolute(normalized), contentToBytes(file.content))
      if (file.mediaType !== undefined || file.metadata !== undefined) {
        this.#files.set(normalized, { mediaType: file.mediaType, metadata: file.metadata })
      }
      else {
        this.#files.delete(normalized)
      }
      await this.#writeFileMetadata()
    })
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    await this.#ensure()
    return this.#listEntries(prefix, options)
  }

  async #listEntries(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeSafeWorkspacePath(prefix, { allowEmpty: true })
    const entries: WorkspaceEntry[] = []

    for (const [absolute, entry] of this.#fs!.entries) {
      if (absolute === dir || !absolute.startsWith(`${dir}/`)) continue
      const path = normalizeWorkspacePath(absolute.slice(`${dir}/`.length))
      if (!path || path === ".git" || path.startsWith(".git/") || path === ".vitehub" || path.startsWith(".vitehub/")) continue
      if (normalizedPrefix) {
        if (path === normalizedPrefix) continue
        if (!path.startsWith(`${normalizedPrefix}/`)) continue
      }
      if (!options.recursive && path.slice(normalizedPrefix ? normalizedPrefix.length + 1 : 0).includes("/")) continue
      if (entry.kind === "file") {
        const fileMetadata = this.#files.get(path)
        entries.push({
          digest: await sha256(entry.data),
          mediaType: fileMetadata?.mediaType,
          metadata: fileMetadata?.metadata,
          mtime: entry.mtimeMs,
          path,
          size: entry.data.byteLength,
          type: "file",
        })
      }
      else {
        entries.push({ mtime: entry.mtimeMs, path, type: "directory" })
      }
    }

    return entries.sort((a, b) => a.path.localeCompare(b.path))
  }

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern) ? pattern.map(normalizeSafeWorkspacePattern) : normalizeSafeWorkspacePattern(pattern)
    const entries = await this.list("", { recursive: true })
    return entries.filter(entry => entry.type === "file" && matchesAny(entry.path, patterns))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    const stat = await this.#fs!.promises.stat(this.#absolute(normalized)).catch(() => undefined) as { isFile(): boolean, isDirectory(): boolean, mtimeMs?: number, size?: number } | undefined
    if (!stat) return undefined
    const bytes = stat.isFile() ? await this.#fs!.promises.readFile(this.#absolute(normalized)) as Uint8Array : undefined
    const fileMetadata = stat.isFile() ? this.#files.get(normalized) : undefined
    return {
      digest: bytes ? await sha256(bytes) : undefined,
      mediaType: fileMetadata?.mediaType,
      metadata: fileMetadata?.metadata,
      mtime: stat.mtimeMs,
      path: normalized,
      size: stat.isFile() ? stat.size : undefined,
      type: stat.isDirectory() ? "directory" : "file",
    }
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    await this.#mutate(() => this.#fs!.promises.mkdir(this.#absolute(normalized), { recursive: options.recursive ?? true }))
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    await this.#mutate(async () => {
      const absolute = this.#absolute(normalized)
      const stat = await this.#fs!.promises.stat(absolute).catch(() => undefined) as { isDirectory(): boolean } | undefined
      if (!stat) {
        if (options.force) return
        throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
      }
      if (stat.isDirectory() && !options.recursive) {
        const children = await this.#fs!.promises.readdir(absolute)
        if (children.length) throw new WorkspaceError(`[vitehub] Workspace directory is not empty: ${path}.`)
      }
      const removed = this.#fs!.deleteTree(absolute)
      if (!removed && !options.force) throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
      for (const key of this.#files.keys()) {
        if (key === normalized || key.startsWith(`${normalized}/`)) this.#files.delete(key)
      }
      await this.#writeFileMetadata()
    })
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    await this.#ensure()
    return this.#mutate(() => this.#createSnapshot(options))
  }

  async #createSnapshot(options: SnapshotOptions): Promise<WorkspaceSnapshot> {
    const git = await import("isomorphic-git")
    const http = await import("isomorphic-git/http/web")
    const matrix = await git.statusMatrix({ dir, fs: this.#fs! as never, ignored: true })
    let changed = false
    for (const [filepath, head, workdir, stage] of matrix) {
      if (filepath.startsWith(".git/")) continue
      if (workdir === 0 && (head !== 0 || stage !== 0)) {
        await git.remove({ dir, filepath, fs: this.#fs! as never })
        changed = true
      }
      else if (workdir !== stage) {
        await git.add({ dir, filepath, force: true, fs: this.#fs! as never })
        changed = true
      }
    }

    if (changed || (!this.#head && !this.#pendingCommit)) {
      this.#pendingCommit = await git.commit({
        author: { email: "workspace@vitehub.dev", name: "ViteHub Workspace" },
        dir,
        fs: this.#fs! as never,
        message: options.name || "Update workspace",
      })
    }

    const id = this.#pendingCommit
    if (id) {
      const token = await this.#writeToken()
      try {
        await git.push({
          dir,
          fs: this.#fs! as never,
          http,
          onAuth: () => ({ password: token, username: "x" }),
          ref: this.#branch,
          url: this.#remote!,
        })
      }
      catch (error) {
        if (isNonFastForward(error)) {
          throw new WorkspaceError(
            `[vitehub] Workspace "${this.workspaceName}" changed remotely while snapshotting branch "${this.#branch}". Reload the Workspace before retrying.`,
            { cause: error },
          )
        }
        throw error
      }
      this.#head = id
      this.#pendingCommit = undefined
    }

    const snapshot = await createSnapshotFromEntries(await this.#listEntries("", { recursive: true }), options.name)
    this.#baseline = { ...snapshot, id: id || this.#head || snapshot.id }
    return this.#baseline
  }

  async diff(options: DiffOptions = {}): Promise<WorkspaceDiff> {
    await this.#ensure()
    const from = options.from || this.#baseline
    const to = await createSnapshotFromEntries(await this.#listEntries("", { recursive: true }))
    return diffSnapshots(from, to)
  }

  async getMeta(key: string): Promise<unknown> {
    const path = this.#metaAbsolute(key)
    await this.#ensure()
    const content = await this.#fs!.promises.readFile(path).catch(() => undefined)
    if (!content) return undefined
    return JSON.parse(new TextDecoder().decode(contentToBytes(content as Uint8Array)))
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const path = this.#metaAbsolute(key)
    await this.#ensure()
    await this.#mutate(() => this.#fs!.promises.writeFile(path, contentToBytes(JSON.stringify(value))))
  }

  #absolute(path: string) {
    return `${dir}/${path}`
  }

  #internalAbsolute(path: string) {
    return `${dir}/${normalizeWorkspacePath(path)}`
  }

  #metaAbsolute(key: string) {
    const normalized = normalizeSafeWorkspacePath(key.endsWith(".json") ? key : `${key}.json`)
    return this.#internalAbsolute(`.vitehub/meta/${normalized}`)
  }

  async #loadFileMetadata(): Promise<void> {
    const content = await this.#fs!.promises.readFile(this.#internalAbsolute(fileMetadataPath)).catch(() => undefined)
    if (!content) return
    const files = JSON.parse(new TextDecoder().decode(content as Uint8Array)) as Record<string, FileMetadata>
    this.#files = new Map(Object.entries(files))
  }

  async #writeFileMetadata(): Promise<void> {
    const path = this.#internalAbsolute(fileMetadataPath)
    if (!this.#files.size) {
      this.#fs!.deleteTree(path)
      return
    }
    const files = Object.fromEntries([...this.#files.entries()].sort(([a], [b]) => a.localeCompare(b)))
    await this.#fs!.promises.writeFile(path, JSON.stringify(files))
  }

  #rememberToken(value: string, expiresAt?: string) {
    this.#token = {
      expiresAt: (expiresAt ? Date.parse(expiresAt) : 0) || tokenExpiresAt(value),
      value: tokenSecret(value),
    }
  }

  async #writeToken(repo?: ArtifactsRepo): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + tokenRefreshWindow) return this.#token.value
    const tokenRepo = repo || await this.#getBinding().get(repoName(this.options, this.workspaceName))
    let token: ArtifactsCreateTokenResult | undefined
    try {
      token = await tokenRepo.createToken("write", 3600)
      this.#rememberToken(token.plaintext, token.expiresAt)
      return this.#token!.value
    }
    finally {
      disposeRpc(token)
      if (!repo) disposeRpc(tokenRepo)
    }
  }

  #getBinding(): ArtifactsBinding {
    const bindingName = this.options.binding || "WORKSPACE_ARTIFACTS"
    const binding = getActiveCloudflareBinding<ArtifactsBinding>(bindingName)
      || (globalThis as Record<string, unknown>)[bindingName] as ArtifactsBinding | undefined
    if (!binding) throw new WorkspaceError(`[vitehub] Cloudflare Artifacts binding "${bindingName}" not found.`)
    return binding
  }

  async #ensure(): Promise<void> {
    this.#ready ||= this.#load()
    await this.#ready
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation)
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #load(): Promise<void> {
    const git = await import("isomorphic-git")
    const http = await import("isomorphic-git/http/web")
    const binding = this.#getBinding()
    const name = repoName(this.options, this.workspaceName)
    let created: ArtifactsCreateRepoResult | undefined
    let repo: ArtifactsRepo | undefined
    let repoInfo: ArtifactsCreateRepoResult | ArtifactsRepoInfo | undefined
    try {
      try {
        repo = await binding.get(name)
      }
      catch (error) {
        if (!hasArtifactsErrorCode(error, "NOT_FOUND", 10200)) throw error
        try {
          created = await binding.create(name, {
            description: `ViteHub workspace ${this.workspaceName}`,
            readOnly: false,
            setDefaultBranch: this.options.branch || "main",
          })
        }
        catch (createError) {
          if (!hasArtifactsErrorCode(createError, "ALREADY_EXISTS", 10201)) throw createError
        }
        repo = await binding.get(name)
      }

      repoInfo = created || await repo.info()
      this.#remote = repoInfo.remote
      this.#branch = this.options.branch || repoInfo.defaultBranch || "main"
      if (created) this.#rememberToken(created.token)
      this.#fs = new MemoryFS()
      await this.#fs.promises.mkdir(dir, { recursive: true })
      const token = await this.#writeToken(repo)
      const branchRef = `refs/heads/${this.#branch}`
      const hasBranch = (
        await git.listServerRefs({
          http,
          onAuth: () => ({ password: token, username: "x" }),
          prefix: branchRef,
          url: this.#remote,
        })
      ).some(ref => ref.ref === branchRef)
      if (!hasBranch) {
        await git.init({ defaultBranch: this.#branch, dir, fs: this.#fs as never })
      }
      else {
        await git.clone({
          depth: 1,
          dir,
          fs: this.#fs as never,
          http,
          onAuth: () => ({ password: token, username: "x" }),
          ref: this.#branch,
          singleBranch: true,
          url: this.#remote,
        })
        this.#head = await git.resolveRef({ dir, fs: this.#fs as never, ref: this.#branch })
      }
    }
    finally {
      try {
        disposeRpc(repoInfo)
        if (created !== repoInfo) disposeRpc(created)
      }
      finally {
        disposeRpc(repo)
      }
    }
    await this.#loadFileMetadata()
    const baseline = await createSnapshotFromEntries(await this.#listEntries("", { recursive: true }))
    this.#baseline = this.#head ? { ...baseline, id: this.#head } : baseline
  }
}

export function createCloudflareArtifactsWorkspaceStore(options: CloudflareArtifactsWorkspaceStoreOptions, workspaceName: string): WorkspaceStore {
  return new CloudflareArtifactsWorkspaceStore(options, workspaceName)
}
