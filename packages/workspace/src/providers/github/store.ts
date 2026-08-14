import { posix } from "node:path";

import { assertWorkspaceDigest, workspaceConflict, workspaceError } from "../../core/errors.ts";
import {
  contentStreamToBytes,
  matchesAny,
  normalizeSafeWorkspacePath,
  normalizeSafeWorkspacePattern,
  normalizeWorkspacePath,
} from "../../core/path.ts";
import { createSnapshotFromEntries, diffSnapshots } from "../../storage/utils.ts";
import { workspaceStoreTarget } from "../../storage/target.ts";
import { workspaceRevisionMaterializer } from "../../storage/materialization.ts";
import {
  commitGitHubChanges,
  createGitHubBlob,
  createGitHubFileUpdate,
  gitBlobSha,
  joinGitPath,
  readGitHubArchive,
  readGitHubRawFile,
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
  WorkspaceRebaseOptions,
  WorkspaceSnapshot,
  WorkspaceStat,
  WorkspaceStreamFile,
  WorkspaceStore,
} from "../../core/types.ts";

interface GitHubWorkspaceStoreFile {
  bytes?: Uint8Array;
  gitSha: string;
  mode?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
  path: string;
  size?: number;
  uploaded?: boolean;
}

function sameGitHubTreeEntry(
  left: GitHubTreeEntry | undefined,
  right: GitHubTreeEntry | undefined,
): boolean {
  return left?.sha === right?.sha && (left?.mode || "100644") === (right?.mode || "100644");
}

function matchesGitHubRemote(
  file: GitHubWorkspaceStoreFile | undefined,
  remote: GitHubTreeEntry | undefined,
): boolean {
  return (
    file?.gitSha === remote?.sha && gitHubFileMode(file?.metadata) === (remote?.mode || "100644")
  );
}

function githubRemoteFile(path: string, entry: GitHubTreeEntry): GitHubWorkspaceStoreFile {
  return {
    gitSha: entry.sha!,
    metadata: gitHubFileMetadata(entry),
    path,
    size: entry.size,
  };
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

function gitHubFileMetadata(entry: GitHubTreeEntry): Record<string, unknown> | undefined {
  return entry.mode === "120000" || entry.mode === "100755" ? { gitMode: entry.mode } : undefined;
}

function gitHubFileMode(metadata: Record<string, unknown> | undefined): string {
  return metadata?.gitMode === "120000" || metadata?.gitMode === "100755"
    ? metadata.gitMode
    : "100644";
}

function inheritedGitHubFileMetadata(
  file: WorkspaceFile,
  current: GitHubWorkspaceStoreFile | undefined,
): Record<string, unknown> | undefined {
  if (file.metadata) return file.metadata;
  return current?.metadata?.gitMode === "100755" ? current.metadata : undefined;
}

function parentDirectories(path: string): string[] {
  const parts = normalizeWorkspacePath(path).split("/").filter(Boolean);
  const directories: string[] = [];
  for (let index = 1; index < parts.length; index++)
    directories.push(parts.slice(0, index).join("/"));
  return directories;
}

function resolveSymlinkTarget(path: string, bytes: Uint8Array): string | undefined {
  const target = gitSymlinkTargetFromBytes(bytes);
  if (!target || target.startsWith("/")) return;
  const base = path.split("/").slice(0, -1).join("/");
  const resolved = posix.normalize(base ? `${base}/${target}` : target);
  if (!resolved || resolved === "." || resolved === ".." || resolved.startsWith("../")) return;
  return normalizeSafeWorkspacePath(resolved);
}

function gitSymlinkTargetFromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0/g, "");
}

async function waitForGitHubOperation<T>(read: Promise<T>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return await read;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class GitHubWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined;
  #archive: { bytes: Uint8Array; revision: string } | undefined;
  #archiveReads = new Map<string, Promise<Uint8Array>>();
  #baselineRefSha: string | undefined;
  #baselineTreeSha: string | undefined;
  #branch: string;
  #dirty = false;
  #files = new Map<string, GitHubWorkspaceStoreFile>();
  #mutationQueue: Promise<void> = Promise.resolve();
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

  [workspaceStoreTarget]() {
    return { provider: "github" as const, branch: this.#branch, repository: this.#repository };
  }

  [workspaceRevisionMaterializer] = {
    currentRevision: async (options?: { abortSignal?: AbortSignal; refresh?: boolean }) => {
      await waitForGitHubOperation(
        this.#mutate(async () => await this.#ensure({ refresh: options?.refresh !== false })),
        options?.abortSignal,
      );
      return this.#baselineRefSha!;
    },
    materializeRevision: async (options?: { abortSignal?: AbortSignal; paths?: readonly string[] }) => {
      await waitForGitHubOperation(
        this.#mutate(async () => await this.#ensure({ refresh: true })),
        options?.abortSignal,
      );
      const revision = this.#baselineRefSha!;
      const paths = options?.paths;
      const files = [...this.#remoteFiles.keys()].filter(path =>
        !isReservedWorkspacePath(path) && (!paths || paths.some(root => path === root || path.startsWith(`${root}/`))),
      ).length;
      if (!this.#dirty && paths === undefined && this.#archive?.revision !== revision) {
        let read = this.#archiveReads.get(revision);
        if (!read) {
          read = readGitHubArchive({
            ref: revision,
            repository: this.#repository,
            token: this.#token,
          });
          this.#archiveReads.set(revision, read);
          void read.finally(() => {
            if (this.#archiveReads.get(revision) === read) this.#archiveReads.delete(revision);
          }).catch(() => {});
        }
        this.#archive = {
          bytes: await waitForGitHubOperation(read, options?.abortSignal),
          revision,
        };
      }
      return {
        ...(!this.#dirty && paths === undefined ? { archive: this.#archive!.bytes } : {}),
        files,
        paths,
        revision,
        root: this.#root,
      };
    },
  };

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeSafeWorkspacePath(path);
    await this.#ensure({ refresh: false });
    return await this.#readWorkspaceFile(normalized);
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    await this.#mutate(async () => {
      const normalized = normalizeSafeWorkspacePath(path);
      await this.#ensure({ refresh: false });
      await this.#writeFile(normalized, file);
    });
  }

  async writeFileConditional(path: string, file: WorkspaceFile, ifDigest: string | null): Promise<void> {
    await this.#mutate(async () => {
      const normalized = normalizeSafeWorkspacePath(path);
      await this.#ensure({ refresh: true });
      assertWorkspaceDigest(normalized, ifDigest, this.#files.get(normalized)?.gitSha);
      await this.#writeFile(normalized, file);
    });
  }

  async #writeFile(normalized: string, file: WorkspaceFile): Promise<void> {
    const current = this.#files.get(normalized);
    const metadata = inheritedGitHubFileMetadata(file, current);
    const content = gitHubFileMode(metadata) === "120000" && typeof metadata?.symlinkTarget === "string"
      ? metadata.symlinkTarget
      : file.content;
    const update = await createGitHubFileUpdate(normalized, this.#root, content);
    if (current?.gitSha === update.gitSha) {
      if (gitHubFileMode(current.metadata) !== gitHubFileMode(metadata)) this.#dirty = true;
      this.#files.set(normalized, {
        ...current,
        mediaType: file.mediaType,
        metadata,
        size: contentLength(content),
      });
      return;
    }
    await createGitHubBlob({
      bytes: update.bytes,
      kind: "store",
      repository: this.#repository,
      token: this.#token,
    });
    this.#files.set(normalized, {
      bytes: update.bytes,
      gitSha: update.gitSha,
      mediaType: file.mediaType,
      metadata,
      path: normalized,
      size: contentLength(content),
      uploaded: true,
    });
    this.#dirty = true;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation);
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async writeFileStream(path: string, file: WorkspaceStreamFile): Promise<WorkspaceStat> {
    const content = await contentStreamToBytes(file.content);
    await this.writeFile(path, {
      path: file.path,
      content,
      mediaType: file.mediaType,
      metadata: file.metadata,
    });
    return {
      digest: await gitBlobSha(content),
      mediaType: file.mediaType,
      path: normalizeSafeWorkspacePath(path),
      size: content.byteLength,
      type: "file",
    };
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    return await this.#mutate(async () => {
      const normalizedPrefix = normalizeSafeWorkspacePath(prefix, { allowEmpty: true });
      await this.#ensure({ refresh: true });
      return await this.#listEntries(normalizedPrefix, options);
    });
  }

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern)
      ? pattern.map(normalizeSafeWorkspacePattern)
      : normalizeSafeWorkspacePattern(pattern);
    const entries = await this.list("", { recursive: true });
    return entries.filter((entry) => entry.type === "file" && matchesAny(entry.path, patterns));
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    return await this.#mutate(async () => {
      const normalized = normalizeSafeWorkspacePath(path);
      await this.#ensure({ refresh: true });
      const file = this.#files.get(normalized);
      if (file && !isReservedWorkspacePath(normalized)) return this.#fileEntry(file);
      if (this.#directoryExists(normalized)) return { path: normalized, type: "directory" };
    });
  }

  async mkdir(path: string, _options: MkdirOptions = {}): Promise<void> {
    normalizeSafeWorkspacePath(path);
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    await this.#mutate(async () => {
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
        throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`);
      }
      if (children.length && !options.recursive) {
        throw workspaceError(`[vitehub] Workspace directory is not empty: ${path}.`);
      }

      for (const child of children) this.#files.delete(child);
      this.#dirty = true;
    });
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    return await this.#mutate(async () => await this.#snapshot(options));
  }

  async rebase(options: WorkspaceRebaseOptions = {}): Promise<void> {
    await this.#mutate(async () => {
      await this.#ensure({ refresh: false });
      const remote = await readGitHubBranchState({
        branch: this.#branch,
        kind: "store",
        repository: this.#repository,
        root: this.#root,
        token: this.#token,
      });
      const takeRemote = options.takeRemote || [];
      const shouldTakeRemote = (path: string) => takeRemote.some(
        root => path === root || path.startsWith(`${root}/`),
      );
      const local = new Map(this.#files);
      const previousRemoteFiles = this.#remoteFiles;
      const changed = new Set([...previousRemoteFiles.keys(), ...local.keys()]);
      if (remote.refSha === this.#baselineRefSha) {
        for (const path of changed) {
          if (!shouldTakeRemote(path)) continue;
          const file = remote.files.get(path);
          if (file) this.#files.set(path, githubRemoteFile(path, file));
          else this.#files.delete(path);
        }
        this.#dirty = [...new Set([...this.#remoteFiles.keys(), ...this.#files.keys()])].some(
          path => !matchesGitHubRemote(this.#files.get(path), this.#remoteFiles.get(path)),
        );
        return;
      }

      for (const path of changed) {
        if (matchesGitHubRemote(local.get(path), previousRemoteFiles.get(path))) {
          changed.delete(path);
          continue;
        }
        const previous = previousRemoteFiles.get(path);
        const current = remote.files.get(path);
        if (
          !sameGitHubTreeEntry(previous, current) &&
          !shouldTakeRemote(path) &&
          !matchesGitHubRemote(local.get(path), current)
        ) {
          throw workspaceConflict(
            `[vitehub] GitHub Workspace Store rebase conflict for ${this.#repository}@${this.#branch}: ${path} changed locally and remotely.`,
          );
        }
      }

      this.#baselineRefSha = remote.refSha;
      this.#baselineTreeSha = remote.treeSha;
      this.#remoteFiles = remote.files;
      this.#files = new Map(
        [...remote.files].map(([path, entry]) => [path, githubRemoteFile(path, entry)]),
      );
      this.#baseline = await createSnapshotFromEntries(
        await this.#listEntries("", { recursive: true }, false),
        "github-workspace-store-rebase",
      );

      for (const path of changed) {
        const remoteChanged = !sameGitHubTreeEntry(
          previousRemoteFiles.get(path),
          remote.files.get(path),
        );
        if (remoteChanged && shouldTakeRemote(path)) continue;
        const file = local.get(path);
        if (file) this.#files.set(path, file);
        else this.#files.delete(path);
      }
      this.#dirty = [...new Set([...this.#remoteFiles.keys(), ...this.#files.keys()])].some(
        (path) => !matchesGitHubRemote(this.#files.get(path), this.#remoteFiles.get(path)),
      );
    });
  }

  async #snapshot(options: SnapshotOptions): Promise<WorkspaceSnapshot> {
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
      throw workspaceConflict(
        `[vitehub] GitHub Workspace Store conflict for ${this.#repository}@${this.#branch}: the branch changed after this Workspace Store loaded. Snapshotting requires a Workspace Store loaded from the current branch head.`,
      );
    }
    this.#remoteFiles = remote.files;
    this.#baselineRefSha = remote.refSha;
    this.#baselineTreeSha = remote.treeSha;

    const changedFiles = [...this.#files.values()].filter(
      (file) => {
        const remote = this.#remoteFiles.get(file.path);
        return remote?.sha !== file.gitSha || (remote.mode || "100644") !== gitHubFileMode(file.metadata);
      },
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
      return {
        bytes: file.uploaded ? undefined : file.bytes,
        fullPath: joinGitPath(this.#root, file.path),
        gitSha: file.gitSha,
        mode: gitHubFileMode(file.metadata),
      };
    });
    const commit = await commitGitHubChanges({
      baseTreeSha: this.#baselineTreeSha,
      branch: this.#branch,
      branchExists: remote.branchExists,
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
    return await this.#mutate(async () => {
      await this.#ensure({ refresh: true });
      const from = options.from || this.#baseline;
      const to = await createSnapshotFromEntries(await this.#listEntries("", { recursive: true }, false));
      return diffSnapshots(from, to);
    });
  }

  async getMeta(key: string): Promise<unknown> {
    return await this.#mutate(async () => {
      await this.#ensure({ refresh: true });
      const file = await this.#readWorkspaceFile(this.#metaPath(key));
      if (!file) return undefined;
      return JSON.parse(new TextDecoder().decode(file.bytes));
    });
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.#mutate(async () => {
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
    });
  }

  async #ensure(options: { refresh: boolean }): Promise<void> {
    const wasReady = !!this.#ready;
    this.#ready ||= this.#load();
    await this.#ready;
    if (wasReady && options.refresh && !this.#dirty) await this.#load();
  }

  async #load(): Promise<void> {
    const previousFiles = this.#files;
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
        [...remote.files].map(([path, entry]) => {
          const previous = previousFiles.get(path);
          return [path, {
            ...(previous && previous.gitSha === entry.sha && gitHubFileMode(previous.metadata) === (entry.mode || "100644")
              ? { bytes: previous.bytes }
              : {}),
            gitSha: entry.sha!,
            metadata: gitHubFileMetadata(entry),
            path,
            size: entry.size,
          }];
        }),
      );
      this.#baseline = await createSnapshotFromEntries(
        await this.#listEntries("", { recursive: true }, false),
        "github-workspace-store-load",
      );
    }
  }

  async #readWorkspaceFile(
    path: string,
    seen = new Set<string>(),
  ): Promise<(WorkspaceFile & { bytes: Uint8Array }) | undefined> {
    const current = this.#files.get(path);
    if (!current) return undefined;
    const currentBytes = await this.#readFileBytes(current);
    if (gitHubFileMode(current.metadata) === "120000" && !seen.has(path)) {
      const target = resolveSymlinkTarget(path, currentBytes);
      if (target && this.#files.has(target)) {
        seen.add(path);
        const resolved = await this.#readWorkspaceFile(target, seen);
        if (resolved) {
          return {
            ...resolved,
            mediaType: current.mediaType ?? resolved.mediaType,
            metadata: await this.#fileMetadata(current) ?? resolved.metadata,
            path,
          };
        }
      }
    }
    return {
      content: currentBytes,
      bytes: currentBytes,
      mediaType: current.mediaType,
      metadata: await this.#fileMetadata(current),
      path,
    };
  }

  async #readFileBytes(file: GitHubWorkspaceStoreFile): Promise<Uint8Array> {
    if (!file.bytes) {
      file.bytes = await readGitHubRawFile({
        path: joinGitPath(this.#root, file.path),
        ref: this.#baselineRefSha!,
        repository: this.#repository,
        token: this.#token,
      });
      file.size = file.bytes.byteLength;
    }
    return file.bytes;
  }

  async #fileMetadata(file: GitHubWorkspaceStoreFile): Promise<Record<string, unknown> | undefined> {
    if (gitHubFileMode(file.metadata) !== "120000" || typeof file.metadata?.symlinkTarget === "string") return file.metadata;
    return {
      ...file.metadata,
      symlinkTarget: gitSymlinkTargetFromBytes(await this.#readFileBytes(file)),
    };
  }

  async #listEntries(prefix: string, options: ListOptions, resolveSymlinks = true): Promise<WorkspaceEntry[]> {
    const entries = new Map<string, WorkspaceEntry>();
    for (const file of this.#files.values()) {
      if (isReservedWorkspacePath(file.path)) continue;
      for (const dir of parentDirectories(file.path)) {
        if (this.#entryInPrefix(dir, prefix, options))
          entries.set(dir, { path: dir, type: "directory" });
      }
      if (this.#entryInPrefix(file.path, prefix, options))
        entries.set(file.path, await this.#fileEntry(file, resolveSymlinks));
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  #entryInPrefix(path: string, prefix: string, options: ListOptions): boolean {
    if (!prefix) return options.recursive || !path.includes("/");
    if (path === prefix) return false;
    if (!path.startsWith(`${prefix}/`)) return false;
    return options.recursive || !path.slice(prefix.length + 1).includes("/");
  }

  async #fileEntry(file: GitHubWorkspaceStoreFile, resolveSymlinks = true): Promise<WorkspaceEntry> {
    return {
      digest: file.gitSha,
      mediaType: file.mediaType,
      metadata: resolveSymlinks ? await this.#fileMetadata(file) : file.metadata,
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
          mode: gitHubFileMode(file.metadata),
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
