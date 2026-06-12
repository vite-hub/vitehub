import { WorkspaceError } from "../../core/errors.ts";
import {
  matchesAny,
  normalizeSafeWorkspacePath,
  normalizeSafeWorkspacePattern,
  normalizeWorkspacePath,
} from "../../core/path.ts";
import { createSnapshotFromEntries, diffSnapshots } from "../../storage/utils.ts";
import {
  commitGitHubChanges,
  createGitHubFileUpdate,
  gitBlobSha,
  joinGitPath,
  readGitHubBlob,
  readGitHubBranchState,
  requireGitHubOption,
  resolveGitHubBranchOption,
  resolveGitHubRepositoryOption,
  resolveGitHubRootOption,
  resolveGitHubTokenOption,
  type GitHubTreeEntry,
} from "./shared.ts";

import type {
  DiffOptions,
  GitHubWorkspaceStoreOptions,
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
} from "../../core/types.ts";

interface GitHubWorkspaceStoreFile {
  bytes?: Uint8Array;
  gitSha: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
  path: string;
  size?: number;
}

function isReservedWorkspacePath(path: string): boolean {
  const root = normalizeWorkspacePath(path).split("/")[0];
  return root === ".git" || root === ".vitehub";
}

function contentLength(content: string | Uint8Array): number {
  return typeof content === "string"
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;
}

function parentDirectories(path: string): string[] {
  const parts = normalizeWorkspacePath(path).split("/").filter(Boolean);
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index++)
    directories.push(parts.slice(0, index).join("/"));
  return directories;
}

class GitHubWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined;
  #baselineRefSha: string | undefined;
  #baselineTreeSha: string | undefined;
  #branch: string;
  #dirty = false;
  #files = new Map<string, GitHubWorkspaceStoreFile>();
  #ready: Promise<void> | undefined;
  #remoteFiles = new Map<string, GitHubTreeEntry>();
  #repository: string;
  #root: string;
  #token: string;

  constructor(
    options: GitHubWorkspaceStoreOptions,
    private workspaceName: string,
  ) {
    this.#repository = requireGitHubOption(
      "store",
      "a repository",
      resolveGitHubRepositoryOption(options),
    );
    this.#branch = resolveGitHubBranchOption(options);
    this.#root = resolveGitHubRootOption(options, workspaceName);
    this.#token = requireGitHubOption("store", "a token", resolveGitHubTokenOption(options));
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeSafeWorkspacePath(path);
    await this.#ensure({ refresh: true });
    return await this.#readWorkspaceFile(normalized);
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path);
    await this.#ensure({ refresh: false });
    const update = await createGitHubFileUpdate(normalized, this.#root, file.content);
    this.#files.set(normalized, {
      bytes: update.bytes,
      gitSha: update.gitSha,
      mediaType: file.mediaType,
      metadata: file.metadata,
      path: normalized,
      size: contentLength(file.content),
    });
    this.#dirty = true;
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeSafeWorkspacePath(prefix, { allowEmpty: true });
    await this.#ensure({ refresh: true });
    return await this.#listEntries(normalizedPrefix, options);
  }

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern)
      ? pattern.map(normalizeSafeWorkspacePattern)
      : normalizeSafeWorkspacePattern(pattern);
    const entries = await this.list("", { recursive: true });
    return entries.filter((entry) => entry.type === "file" && matchesAny(entry.path, patterns));
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const normalized = normalizeSafeWorkspacePath(path);
    await this.#ensure({ refresh: true });
    const file = this.#files.get(normalized);
    if (file && !isReservedWorkspacePath(normalized)) return this.#fileEntry(file);
    if (this.#directoryExists(normalized)) return { path: normalized, type: "directory" };
  }

  async mkdir(path: string, _options: MkdirOptions = {}): Promise<void> {
    normalizeSafeWorkspacePath(path);
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path);
    await this.#ensure({ refresh: false });
    const file = this.#files.get(normalized);
    if (file && !isReservedWorkspacePath(normalized)) {
      this.#files.delete(normalized);
      this.#dirty = true;
      return;
    }

    const children = this.#publicDescendants(normalized);
    const hasDirectory = children.length > 0;
    if (!hasDirectory) {
      if (options.force) return;
      throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`);
    }
    if (children.length && !options.recursive) {
      throw new WorkspaceError(`[vitehub] Workspace directory is not empty: ${path}.`);
    }

    for (const child of children) this.#files.delete(child);
    this.#dirty = true;
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    await this.#ensure({ refresh: false });
    const snapshot = await createSnapshotFromEntries(
      await this.#listEntries("", { recursive: true }),
      options.name,
    );

    if (!this.#dirty) {
      this.#baseline = snapshot;
      return snapshot;
    }

    const remote = await readGitHubBranchState({
      branch: this.#branch,
      kind: "store",
      repository: this.#repository,
      root: this.#root,
      token: this.#token,
    });
    if (this.#baselineRefSha && remote.refSha !== this.#baselineRefSha) {
      throw new WorkspaceError(
        `[vitehub] GitHub Workspace Store conflict for ${this.#repository}@${this.#branch}: the branch changed after this Workspace Store loaded. Retry with a fresh Workspace Store before snapshotting.`,
      );
    }
    this.#remoteFiles = remote.files;
    this.#baselineRefSha = remote.refSha;
    this.#baselineTreeSha = remote.treeSha;

    const changedFiles = [...this.#files.values()].filter(
      (file) => this.#remoteFiles.get(file.path)?.sha !== file.gitSha,
    );
    const deletePaths = [...this.#remoteFiles]
      .filter(([path]) => !this.#files.has(path))
      .map(([, entry]) => entry.path);

    if (!changedFiles.length && !deletePaths.length) {
      this.#dirty = false;
      this.#baseline = snapshot;
      return snapshot;
    }

    const files = changedFiles.map((file) => {
      if (!file.bytes) {
        throw new WorkspaceError(
          `[vitehub] GitHub Workspace Store cannot commit ${file.path} because its content was not loaded.`,
        );
      }
      return {
        bytes: file.bytes,
        fullPath: joinGitPath(this.#root, file.path),
        gitSha: file.gitSha,
      };
    });
    const commit = await commitGitHubChanges({
      baseTreeSha: this.#baselineTreeSha,
      branch: this.#branch,
      deletePaths,
      files,
      message: options.name || "chore: update workspace snapshot",
      parentSha: this.#baselineRefSha,
      repository: this.#repository,
      token: this.#token,
    });

    this.#dirty = false;
    this.#baselineRefSha = commit.commitSha;
    this.#baselineTreeSha = commit.treeSha;
    this.#remoteFiles = this.#toRemoteFiles();
    this.#baseline = { ...snapshot, id: commit.commitSha };
    return this.#baseline;
  }

  async diff(options: DiffOptions = {}): Promise<WorkspaceDiff> {
    const from = options.from || this.#baseline;
    const to = await createSnapshotFromEntries(await this.list("", { recursive: true }));
    return diffSnapshots(from, to);
  }

  async getMeta(key: string): Promise<unknown> {
    await this.#ensure({ refresh: true });
    const file = await this.#readWorkspaceFile(this.#metaPath(key));
    if (!file) return undefined;
    return JSON.parse(new TextDecoder().decode(file.bytes));
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const path = this.#metaPath(key);
    const content = JSON.stringify(value);
    const bytes = new TextEncoder().encode(content);
    await this.#ensure({ refresh: false });
    this.#files.set(path, {
      bytes,
      gitSha: await gitBlobSha(bytes),
      path,
      size: bytes.byteLength,
    });
    this.#dirty = true;
  }

  async #ensure(options: { refresh: boolean }): Promise<void> {
    const wasReady = !!this.#ready;
    this.#ready ||= this.#load();
    await this.#ready;
    if (wasReady && options.refresh && !this.#dirty) await this.#load();
  }

  async #load(): Promise<void> {
    const remote = await readGitHubBranchState({
      branch: this.#branch,
      kind: "store",
      repository: this.#repository,
      root: this.#root,
      token: this.#token,
    });
    this.#baselineRefSha = remote.refSha;
    this.#baselineTreeSha = remote.treeSha;
    this.#remoteFiles = remote.files;
    if (!this.#dirty) {
      this.#files = new Map(
        [...remote.files].map(([path, entry]) => [
          path,
          {
            gitSha: entry.sha!,
            path,
            size: entry.size,
          },
        ]),
      );
    }
  }

  async #readWorkspaceFile(
    path: string,
  ): Promise<(WorkspaceFile & { bytes: Uint8Array }) | undefined> {
    const current = this.#files.get(path);
    if (!current) return undefined;
    if (!current.bytes) {
      current.bytes = await readGitHubBlob({
        kind: "store",
        repository: this.#repository,
        sha: current.gitSha,
        token: this.#token,
      });
      current.size = current.bytes.byteLength;
    }
    return {
      content: current.bytes,
      bytes: current.bytes,
      mediaType: current.mediaType,
      metadata: current.metadata,
      path,
    };
  }

  async #listEntries(prefix: string, options: ListOptions): Promise<WorkspaceEntry[]> {
    const entries = new Map<string, WorkspaceEntry>();
    for (const file of this.#files.values()) {
      if (isReservedWorkspacePath(file.path)) continue;
      for (const dir of parentDirectories(file.path)) {
        if (this.#entryInPrefix(dir, prefix, options))
          entries.set(dir, { path: dir, type: "directory" });
      }
      if (this.#entryInPrefix(file.path, prefix, options))
        entries.set(file.path, await this.#fileEntry(file));
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  #entryInPrefix(path: string, prefix: string, options: ListOptions): boolean {
    if (!prefix) return options.recursive || !path.includes("/");
    if (path === prefix) return false;
    if (!path.startsWith(`${prefix}/`)) return false;
    return options.recursive || !path.slice(prefix.length + 1).includes("/");
  }

  #fileEntry(file: GitHubWorkspaceStoreFile): WorkspaceEntry {
    return {
      digest: file.gitSha,
      mediaType: file.mediaType,
      path: file.path,
      size: file.size,
      type: "file",
    };
  }

  #directoryExists(path: string): boolean {
    return this.#publicDescendants(path).length > 0;
  }

  #publicDescendants(path: string): string[] {
    return [...this.#files.keys()].filter(
      (key) => !isReservedWorkspacePath(key) && key.startsWith(`${path}/`),
    );
  }

  #metaPath(key: string): string {
    const normalized = normalizeSafeWorkspacePath(key.endsWith(".json") ? key : `${key}.json`, {
      allowReserved: true,
    });
    return normalizeSafeWorkspacePath(`.vitehub/meta/${normalized}`, { allowReserved: true });
  }

  #toRemoteFiles(): Map<string, GitHubTreeEntry> {
    return new Map(
      [...this.#files.values()].map((file) => [
        file.path,
        {
          path: joinGitPath(this.#root, file.path),
          sha: file.gitSha,
          size: file.size,
          type: "blob",
        },
      ]),
    );
  }
}

export function createGitHubWorkspaceStore(
  options: GitHubWorkspaceStoreOptions,
  workspaceName: string,
): WorkspaceStore {
  return new GitHubWorkspaceStore(options, workspaceName);
}
