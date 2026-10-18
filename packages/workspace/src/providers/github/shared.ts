import {
  BranchMovedError,
  forgeArchive,
  forgeBlob,
  forgeCommitFiles,
  forgeEnv,
  forgeErrorStatus,
  forgeProvider,
  ForgeResponseError,
  readForgeEnv,
} from "@vite-hub/forge";
import type { ForgeFileChange, ForgeFileMode } from "@vite-hub/forge";
import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env";

import { workspaceConflict, workspaceError } from "../../core/errors.ts";
import { contentToBytes, normalizeSafeWorkspacePath, normalizeWorkspacePath } from "../../core/path.ts";

import type { GitHubWorkspaceOption } from "../../core/types.ts";

export interface GitHubWorkspaceOptions {
  branch?: GitHubWorkspaceOption;
  repo?: GitHubWorkspaceOption;
  repository?: GitHubWorkspaceOption;
  root?: GitHubWorkspaceOption;
  token?: GitHubWorkspaceOption;
}

export type GitHubProvider = Awaited<ReturnType<typeof forgeProvider>>;
type GitHubRepoRef = Parameters<GitHubProvider["repos"]["get"]>[0];
export type GitFileMode = ForgeFileMode;

/** One file of the remote tree. `path` is from the repository root. */
export interface GitHubTreeEntry {
  mode: GitFileMode;
  path: string;
  sha: string;
  size?: number;
}

export interface GitHubBranchState {
  branchExists: boolean;
  files: Map<string, GitHubTreeEntry>;
  refSha: string;
}

export interface GitHubFileUpdate {
  bytes: Uint8Array;
  fullPath: string;
  mode: GitFileMode;
}

/** One GitHub repository and the Forge provider that reaches it. */
export interface GitHubRepository {
  /** `owner/repo`, for messages. */
  name: string;
  provider: () => Promise<GitHubProvider>;
  ref: (provider: GitHubProvider) => GitHubRepoRef;
}

export interface GitHubWorkspaceStoreTarget {
  provider: "github";
  branch: string;
  repository: string;
}

const githubReadAttempts = 3;

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 2_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 2_000);
  }
  return 100 * 2 ** attempt;
}

async function waitForRetry(delay: number, signal?: AbortSignal | null) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timeout);
      reject(signal?.reason || new DOMException("The operation was aborted.", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, delay);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** `fetch` that retries reads after a network error, a 429 or a 5xx response. The Forge provider sends every request through it. */
export async function requestGitHub(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(input, init);
    }
    catch (error) {
      if (!retryable || init.signal?.aborted || attempt + 1 >= githubReadAttempts) throw error;
      await waitForRetry(100 * 2 ** attempt, init.signal);
      continue;
    }
    if (!retryable || (response.status !== 429 && response.status < 500) || attempt + 1 >= githubReadAttempts) return response;
    await response.body?.cancel().catch(() => undefined);
    await waitForRetry(retryDelay(response, attempt), init.signal);
  }
}

/** A lazy connection: the repository name is checked on the first request. */
export function connectGitHubRepository(repository: string, token: string): GitHubRepository {
  let provider: Promise<GitHubProvider> | undefined;
  return {
    name: repository,
    provider: async () => {
      splitGitHubRepository(repository);
      return await (provider ||= forgeProvider({ fetch: requestGitHub, forge: "github", token, userAgent: "vitehub-workspace" }));
    },
    ref: (client) => {
      const { owner, repo } = splitGitHubRepository(repository);
      return { forge: client.forge, instance: client.instance, name: repo, owner };
    },
  };
}

/**
 * Run one Forge call. A failed request becomes a Workspace error that keeps the Forge error as its cause.
 * With `response`, a `TypeError` from the Forge response mapping becomes a malformed `response` error.
 */
export async function githubRequest<T>(
  repository: GitHubRepository,
  run: (provider: GitHubProvider, repo: GitHubRepoRef) => Promise<T>,
  response?: string,
): Promise<T> {
  const provider = await repository.provider();
  try {
    return await run(provider, repository.ref(provider));
  }
  catch (error) {
    const status = forgeErrorStatus(error);
    if (status === undefined && response && error instanceof ForgeResponseError) {
      throw workspaceError(`[vitehub] GitHub workspace returned a malformed ${response} response.`, { cause: error });
    }
    if (status === undefined) throw error;
    throw workspaceError(`[vitehub] GitHub workspace request failed for ${repository.name}: ${status} ${error instanceof Error ? error.message : ""}`.trim(), { cause: error });
  }
}

/** The HTTP status of the GitHub request behind a Workspace error. */
export function githubRequestStatus(error: unknown): number | undefined {
  return forgeErrorStatus(error) ?? (error instanceof Error ? forgeErrorStatus(error.cause) : undefined);
}

export function githubBranchMovedConflict(input: {
  actualHead?: string;
  branch: string;
  expectedHead: string;
  repository: string;
}): ReturnType<typeof workspaceConflict> {
  return workspaceConflict(
    `[vitehub] GitHub Workspace Store conflict for ${input.repository}@${input.branch}: the branch moved after this Workspace Store loaded. Rebase from the current branch head and retry.`,
    {
      details: {
        actualHead: input.actualHead,
        branch: input.branch,
        expectedHead: input.expectedHead,
        repository: input.repository,
      },
    },
  );
}

export function resolveGitHubOption(value: GitHubWorkspaceOption | undefined): string | undefined {
  const resolved = typeof value === "function" ? value() : value;
  return typeof resolved === "string" ? resolved.trim() || undefined : resolved;
}

function isMaskedGitHubTokenOption(value: string): boolean {
  return value === "********" || value === "<redacted>" || value === "[redacted]";
}

/** The first location value that is set, from the active Cloudflare bindings and then from `env`. */
function readLocationEnv(name: string, env: Record<string, string | undefined>): string | undefined {
  const binding = getActiveCloudflareBinding<unknown>(name);
  if (typeof binding === "string" && binding.trim()) return binding.trim();
  return env[name]?.trim() || undefined;
}

/** The Server Env GitHub token: `VITEHUB_GITHUB_TOKEN`, then `FORGES_GITHUB_TOKEN`, from the active Cloudflare bindings and then from `env`. */
export function readGitHubEnvToken(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  const binding = readForgeEnv(forgeEnv.github.token, name => getActiveCloudflareBinding<unknown>(name));
  if (binding && !isMaskedGitHubTokenOption(binding)) return binding;
  return readForgeEnv(forgeEnv.github.token, env);
}

export function requireGitHubOption(
  label: string,
  value: string | undefined,
): string {
  if (!value) throw workspaceError(`[vitehub] GitHub workspace store requires ${label}.`);
  return value;
}

export function splitGitHubRepository(
  repository: string,
): { owner: string; repo: string } {
  const parts = repository.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (
    parts.length !== 2
    || !owner || /[^A-Za-z0-9-]/.test(owner)
    || !repo || /[^A-Za-z0-9_.-]/.test(repo) || repo === "." || repo === ".."
  ) {
    throw workspaceError(
      "[vitehub] GitHub workspace store requires a repository in owner/repo format.",
    );
  }
  return { owner: owner, repo: repo };
}

export function joinGitPath(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}

export function resolveGitHubWorkspaceRoot(root: string, workspaceName: string): string {
  return normalizeSafeWorkspacePath(joinGitPath(root.replaceAll("<workspace>", workspaceName)), {
    allowEmpty: true,
    allowReserved: true,
  });
}

function workspacePathFromGitPath(path: string, root: string): string | undefined {
  const normalized = joinGitPath(path);
  const normalizedRoot = joinGitPath(root);
  if (!normalizedRoot) return normalizeWorkspacePath(normalized);
  if (!normalized.startsWith(`${normalizedRoot}/`)) return undefined;
  return normalizeWorkspacePath(normalized.slice(normalizedRoot.length + 1));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Git blob sha of `bytes`. Workspace digests are Git blob shas, so local writes compare with the remote tree. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const input = new Uint8Array(prefix.byteLength + bytes.byteLength);
  input.set(prefix);
  input.set(bytes, prefix.byteLength);
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", input)));
}

export function gitFileMode(value: unknown): GitFileMode {
  return value === "120000" || value === "100755" ? value : "100644";
}

export function resolveGitHubRepositoryOption(
  options: GitHubWorkspaceOptions,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  return (
    resolveGitHubOption(options.repository) ||
    resolveGitHubOption(options.repo) ||
    readLocationEnv("VITEHUB_WORKSPACE_GITHUB_REPOSITORY", env)
  );
}

export function resolveGitHubBranchOption(
  options: GitHubWorkspaceOptions,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string {
  return (
    resolveGitHubOption(options.branch) ||
    readLocationEnv("VITEHUB_WORKSPACE_GITHUB_BRANCH", env) ||
    "main"
  );
}

export function resolveGitHubRootOption(
  options: GitHubWorkspaceOptions,
  workspaceName: string,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string {
  return resolveGitHubWorkspaceRoot(
    resolveGitHubOption(options.root) ||
      readLocationEnv("VITEHUB_WORKSPACE_GITHUB_ROOT", env) ||
      ".vitehub/workspaces/<workspace>",
    workspaceName,
  );
}

export function resolveGitHubTokenOption(
  options: GitHubWorkspaceOptions,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  const token = resolveGitHubOption(options.token);
  if (token && !isMaskedGitHubTokenOption(token)) return token;
  return readGitHubEnvToken(env);
}

/** The bytes of one remote file. A symlink is read by its blob, so the bytes are the link target and not the file it points at. */
export async function readGitHubFile(
  repository: GitHubRepository,
  entry: Pick<GitHubTreeEntry, "mode" | "path" | "sha">,
  ref: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return await githubRequest(repository, async (provider, repo) => {
    // GitHub's Contents API truncates or returns empty content for large files.
    // Read the blob by sha so regular files are complete as well as symlinks.
    return await forgeBlob(provider, repo, entry.sha, { signal });
  });
}

export async function readGitHubArchive(repository: GitHubRepository, ref: string, signal?: AbortSignal): Promise<Uint8Array> {
  return await githubRequest(repository, async (provider, repo) => {
    const stream = await forgeArchive(provider, repo, { ref, signal });
    return new Uint8Array(await new Response(stream).arrayBuffer());
  });
}

/** The files and symlinks of the tree at `ref`, by their Workspace path under `root`. */
export async function readGitHubTree(
  repository: GitHubRepository,
  ref: string,
  root: string,
): Promise<Map<string, GitHubTreeEntry>> {
  return await githubRequest(repository, async (provider, repo) => {
    const tree = provider.contents.tree(repo, { recursive: true, ref });
    const files = new Map<string, GitHubTreeEntry>();
    for await (const entry of tree) {
      if (entry.type !== "file" && entry.type !== "symlink") continue;
      if (!entry.sha) throw workspaceError("[vitehub] GitHub workspace returned a malformed tree response.");
      const path = workspacePathFromGitPath(entry.path, root);
      if (path) files.set(path, { mode: gitFileMode(entry.mode), path: entry.path, sha: entry.sha, size: entry.size });
    }
    if (tree.warnings.some(warning => warning.code === "tree_truncated")) {
      throw workspaceError(
        "[vitehub] GitHub workspace store could not compare the remote tree because GitHub returned a truncated tree.",
      );
    }
    return files;
  }, "tree");
}

function isMissingRef(error: unknown): boolean {
  const status = githubRequestStatus(error);
  return status === 404 || status === 422;
}

/** The head of `branch`, or of the default branch when `branch` does not exist yet, and the files under `root`. */
export async function readGitHubBranchState(input: {
  branch: string;
  repository: GitHubRepository;
  root: string;
}): Promise<GitHubBranchState> {
  const resolve = async (branch: string) => {
    const sha = await githubRequest(input.repository, async (provider, repo) => await provider.contents.resolveRef(repo, branch), "commit");
    if (!sha) throw workspaceError("[vitehub] GitHub workspace returned a malformed commit response.");
    return sha;
  };
  let branchExists = true;
  let refSha: string;
  try {
    refSha = await resolve(input.branch);
  }
  catch (error) {
    if (!isMissingRef(error)) throw error;
    const repository = await githubRequest(input.repository, async (provider, repo) => await provider.repos.get(repo), "repository");
    if (!repository.defaultBranch) throw workspaceError("[vitehub] GitHub workspace returned a malformed repository response.");
    refSha = await resolve(repository.defaultBranch);
    branchExists = false;
  }
  return {
    branchExists,
    files: await readGitHubTree(input.repository, refSha, input.root),
    refSha,
  };
}

/**
 * Write and delete files in one commit on `branch`, and return the commit sha.
 * A branch that does not exist yet is created from `parentSha`.
 * Rejects with a Workspace conflict when the branch no longer points at `parentSha`.
 */
export async function commitGitHubChanges(input: {
  branch: string;
  branchExists: boolean;
  deletePaths: string[];
  files: GitHubFileUpdate[];
  message: string;
  parentSha: string;
  /** Remote modes, so a write that changes or keeps a mode other than `100644` sends it. */
  remoteModes?: ReadonlyMap<string, GitFileMode>;
  repository: GitHubRepository;
}): Promise<string> {
  // A change without a mode goes through `commitFiles()`, which cannot set a mode.
  // Send modes only when one write needs a mode other than `100644`.
  const needsModes = input.files.some(file => file.mode !== "100644" || (input.remoteModes?.get(file.fullPath) ?? "100644") !== "100644");
  const changes: ForgeFileChange[] = [
    ...input.files.map(file => ({ content: file.bytes, path: file.fullPath, ...(needsModes ? { mode: file.mode } : {}) })),
    ...input.deletePaths.map(path => ({ content: null, path })),
  ];
  try {
    return await githubRequest(input.repository, async (provider, repo) => await forgeCommitFiles(provider, repo, {
      branch: input.branch,
      changes,
      message: input.message,
      ...(input.branchExists ? { expectedHead: input.parentSha } : { createFrom: input.parentSha }),
    }));
  }
  catch (error) {
    if (error instanceof BranchMovedError || (error instanceof Error && error.cause instanceof BranchMovedError)) {
      throw githubBranchMovedConflict({
        branch: input.branch,
        expectedHead: input.parentSha,
        repository: input.repository.name,
      });
    }
    throw error;
  }
}

export function createGitHubFileUpdate(
  path: string,
  root: string,
  content: string | Uint8Array,
  mode: GitFileMode = "100644",
): GitHubFileUpdate {
  return {
    bytes: contentToBytes(content),
    fullPath: joinGitPath(root, path),
    mode,
  };
}
