import { getActiveCloudflareBinding } from "@vitehub/internal/runtime/cloudflare-env"

import { WorkspaceError } from "../errors.ts"
import { contentToBytes, matchesAny, normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern, normalizeWorkspacePath, sha256 } from "../path.ts"
import { MemoryFS } from "./memory-fs.ts"
import { createSnapshotFromEntries, diffSnapshots } from "./utils.ts"

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
} from "../types.ts"

interface ArtifactsRepo {
  createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string }>
  defaultBranch?: string
  name: string
  remote: string
}

interface ArtifactsBinding {
  create(name: string, options?: { description?: string, readOnly?: boolean, setDefaultBranch?: string }): Promise<ArtifactsRepo & { token?: string }>
  get(name: string): Promise<ArtifactsRepo>
}

const dir = "/workspace"

function tokenSecret(token: string) {
  return token.split("?expires=")[0] || token
}

function repoName(options: CloudflareArtifactsWorkspaceStoreOptions, workspaceName: string) {
  return options.repo || `${options.repoPrefix || "vitehub-workspace-"}${workspaceName.replace(/[^a-zA-Z0-9_.-]/g, "-")}`
}

class CloudflareArtifactsWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined
  #fs: MemoryFS | undefined
  #repo: ArtifactsRepo | undefined
  #token: string | undefined
  #ready: Promise<void> | undefined

  constructor(private options: CloudflareArtifactsWorkspaceStoreOptions, private workspaceName: string) {}

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    const filepath = this.#absolute(normalized)
    const content = await this.#fs!.promises.readFile(filepath).catch(() => undefined)
    return content ? { path: normalized, content: content as Uint8Array } : undefined
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    await this.#fs!.promises.writeFile(this.#absolute(normalized), contentToBytes(file.content))
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeSafeWorkspacePath(prefix, { allowEmpty: true })
    await this.#ensure()
    const entries: WorkspaceEntry[] = []

    for (const [absolute, entry] of this.#fs!.entries) {
      if (absolute === dir || !absolute.startsWith(`${dir}/`)) continue
      const path = normalizeWorkspacePath(absolute.slice(`${dir}/`.length))
      if (!path || path === ".git" || path.startsWith(".git/") || path.startsWith(".vitehub/")) continue
      if (normalizedPrefix) {
        if (path === normalizedPrefix) continue
        if (!path.startsWith(`${normalizedPrefix}/`)) continue
      }
      if (!options.recursive && path.slice(normalizedPrefix ? normalizedPrefix.length + 1 : 0).includes("/")) continue
      if (entry.kind === "file") {
        entries.push({
          digest: await sha256(entry.data),
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
    return {
      digest: bytes ? await sha256(bytes) : undefined,
      mtime: stat.mtimeMs,
      path: normalized,
      size: stat.isFile() ? stat.size : undefined,
      type: stat.isDirectory() ? "directory" : "file",
    }
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
    await this.#fs!.promises.mkdir(this.#absolute(normalized), { recursive: options.recursive ?? true })
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    await this.#ensure()
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
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    await this.#ensure()
    const git = await import("isomorphic-git")
    const http = await import("isomorphic-git/http/web")
    const matrix = await git.statusMatrix({ dir, fs: this.#fs! as never })
    let changed = false
    for (const [filepath, head, workdir, stage] of matrix) {
      if (filepath.startsWith(".git/")) continue
      if (workdir === 0 && (head !== 0 || stage !== 0)) {
        await git.remove({ dir, filepath, fs: this.#fs! as never })
        changed = true
      }
      else if (workdir !== stage) {
        await git.add({ dir, filepath, fs: this.#fs! as never })
        changed = true
      }
    }

    let id: string | undefined
    if (changed) {
      id = await git.commit({
        author: { email: "workspace@vitehub.dev", name: "ViteHub Workspace" },
        dir,
        fs: this.#fs! as never,
        message: options.name || "Update workspace",
      })
      await git.push({
        dir,
        fs: this.#fs! as never,
        http,
        onAuth: () => ({ password: this.#token!, username: "x" }),
        ref: this.options.branch || "main",
        url: this.#repo!.remote,
      })
    }

    const snapshot = await createSnapshotFromEntries(await this.list("", { recursive: true }), options.name)
    this.#baseline = { ...snapshot, id: id || snapshot.id }
    return this.#baseline
  }

  async diff(options: DiffOptions = {}): Promise<WorkspaceDiff> {
    const from = options.from || this.#baseline
    const to = await createSnapshotFromEntries(await this.list("", { recursive: true }))
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
    await this.#fs!.promises.writeFile(path, contentToBytes(JSON.stringify(value)))
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

  #getBinding(): ArtifactsBinding {
    const bindingName = this.options.binding || "WORKSPACE_ARTIFACTS"
    const binding = getActiveCloudflareBinding<ArtifactsBinding>(bindingName)
      || (globalThis as { __env__?: Record<string, unknown> }).__env__?.[bindingName] as ArtifactsBinding | undefined
      || (globalThis as Record<string, unknown>)[bindingName] as ArtifactsBinding | undefined
    if (!binding) throw new WorkspaceError(`[vitehub] Cloudflare Artifacts binding "${bindingName}" not found.`)
    return binding
  }

  async #ensure(): Promise<void> {
    this.#ready ||= this.#load()
    await this.#ready
  }

  async #load(): Promise<void> {
    const git = await import("isomorphic-git")
    const http = await import("isomorphic-git/http/web")
    const binding = this.#getBinding()
    const name = repoName(this.options, this.workspaceName)
    let createdToken: string | undefined
    try {
      this.#repo = await binding.get(name)
    }
    catch {
      const created = await binding.create(name, {
        description: `ViteHub workspace ${this.workspaceName}`,
        readOnly: false,
        setDefaultBranch: this.options.branch || "main",
      })
      this.#repo = created
      createdToken = created.token
    }

    this.#token = tokenSecret(createdToken || (await this.#repo.createToken("write", 3600)).plaintext)
    this.#fs = new MemoryFS()
    await this.#fs.promises.mkdir(dir, { recursive: true })
    try {
      await git.clone({
        depth: 1,
        dir,
        fs: this.#fs as never,
        http,
        onAuth: () => ({ password: this.#token!, username: "x" }),
        ref: this.options.branch || this.#repo.defaultBranch || "main",
        singleBranch: true,
        url: this.#repo.remote,
      })
    }
    catch {
      await git.init({ defaultBranch: this.options.branch || "main", dir, fs: this.#fs as never })
    }
  }
}

export function createCloudflareArtifactsWorkspaceStore(options: CloudflareArtifactsWorkspaceStoreOptions, workspaceName: string): WorkspaceStore {
  return new CloudflareArtifactsWorkspaceStore(options, workspaceName)
}
