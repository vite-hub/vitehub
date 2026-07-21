import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env";

import { WorkspaceError } from "../../core/errors.ts";
import { contentToBytes, normalizeWorkspacePath } from "../../core/path.ts";

import type { GitHubWorkspaceOption, WorkspaceEntry } from "../../core/types.ts";

export interface GitHubWorkspaceOptions {
  branch?: GitHubWorkspaceOption;
  repo?: GitHubWorkspaceOption;
  repository?: GitHubWorkspaceOption;
  root?: GitHubWorkspaceOption;
  token?: GitHubWorkspaceOption;
}

export interface GitHubTreeEntry {
  mode?: string;
  path: string;
  sha?: string | null;
  size?: number;
  type: string;
}

export interface GitHubTreeResponse {
  tree: GitHubTreeEntry[];
  truncated?: boolean;
}

export interface GitHubBranchState {
  branchExists: boolean;
  files: Map<string, GitHubTreeEntry>;
  refSha: string;
  treeSha: string;
}

export interface GitHubFileUpdate {
  bytes?: Uint8Array;
  fullPath: string;
  gitSha: string;
  mode?: string;
}

export interface GitHubCommitResult {
  commitSha: string;
  treeSha: string;
}

class GitHubRequestError extends WorkspaceError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const githubWorkspaceStoreTarget = Symbol.for("vitehub.workspace.githubStoreTarget");

export interface GitHubWorkspaceStoreTarget {
  branch: string;
  repository: string;
}

export function processEnv(
  env: Record<string, string | undefined>,
  ...keys: string[]
): string | undefined {
  return keys.map((key) => env[key]).find((value) => typeof value === "string" && value.length > 0);
}

export function resolveGitHubOption(value: GitHubWorkspaceOption | undefined): string | undefined {
  return typeof value === "function" ? value() : value;
}

function isMaskedGitHubTokenOption(value: string): boolean {
  return value === "********" || value === "<redacted>" || value === "[redacted]";
}

export function requireGitHubOption(
  kind: "publisher" | "store",
  label: string,
  value: string | undefined,
): string {
  if (!value) throw new WorkspaceError(`[vitehub] GitHub workspace ${kind} requires ${label}.`);
  return value;
}

export function splitGitHubRepository(
  repository: string,
  kind: "publisher" | "store",
): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new WorkspaceError(
      `[vitehub] GitHub workspace ${kind} requires a repository in owner/repo format.`,
    );
  }
  return { owner: owner, repo: repo };
}

export function joinGitPath(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}

export function resolveGitHubWorkspaceRoot(root: string, workspaceName: string): string {
  return joinGitPath(root.replaceAll("<workspace>", workspaceName));
}

export function workspacePathFromGitPath(path: string, root: string): string | undefined {
  const normalized = joinGitPath(path);
  const normalizedRoot = joinGitPath(root);
  if (!normalizedRoot) return normalizeWorkspacePath(normalized);
  if (!normalized.startsWith(`${normalizedRoot}/`)) return undefined;
  return normalizeWorkspacePath(normalized.slice(normalizedRoot.length + 1));
}

export function isWorkspaceFileEntry(
  entry: WorkspaceEntry,
): entry is WorkspaceEntry & { type: "file" } {
  return entry.type === "file";
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const input = new Uint8Array(prefix.byteLength + bytes.byteLength);
  input.set(prefix);
  input.set(bytes, prefix.byteLength);
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", input)));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const encode = (globalThis as { btoa?: (input: string) => string }).btoa;
  return encode ? encode(binary) : Buffer.from(bytes).toString("base64");
}

export function fromBase64(input: string): Uint8Array {
  const normalized = input.replace(/\s/g, "");
  const decode = (globalThis as { atob?: (value: string) => string }).atob;
  if (!decode) return new Uint8Array(Buffer.from(normalized, "base64"));
  const binary = decode(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function resolveGitHubRepositoryOption(
  options: GitHubWorkspaceOptions,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  return (
    resolveGitHubOption(options.repository) ||
    resolveGitHubOption(options.repo) ||
    processEnv(
      env,
      "WORKSPACE_GITHUB_REPOSITORY",
      "VITEHUB_WORKSPACE_GITHUB_REPOSITORY",
      "GITHUB_REPOSITORY",
    )
  );
}

export function resolveGitHubBranchOption(
  options: GitHubWorkspaceOptions,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string {
  return (
    resolveGitHubOption(options.branch) ||
    processEnv(
      env,
      "WORKSPACE_GITHUB_BRANCH",
      "VITEHUB_WORKSPACE_GITHUB_BRANCH",
      "GITHUB_BRANCH",
    ) ||
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
      processEnv(env, "WORKSPACE_GITHUB_ROOT", "VITEHUB_WORKSPACE_GITHUB_ROOT") ||
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
  const bindingToken = getActiveCloudflareBinding<string>("GITHUB_TOKEN");
  if (bindingToken && !isMaskedGitHubTokenOption(bindingToken)) return bindingToken;
  return (
    processEnv(env, "WORKSPACE_GITHUB_TOKEN", "VITEHUB_WORKSPACE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN")
  );
}

export async function requestGitHubJson<T>(
  repository: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
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
  });

  if (!response.ok) {
    throw new GitHubRequestError(
      `[vitehub] GitHub workspace request failed for ${repository}: ${response.status} ${response.statusText} ${await response.text().catch(() => "")}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export async function requestGitHubBytes(
  repository: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Uint8Array> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github.raw+json",
      authorization: `Bearer ${token}`,
      "user-agent": "vitehub-workspace",
      "x-github-api-version": "2022-11-28",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new WorkspaceError(
      `[vitehub] GitHub workspace request failed for ${repository}: ${response.status} ${response.statusText} ${await response.text().catch(() => "")}`,
    );
  }
  if (response.headers.get("content-type")?.includes("application/json")) {
    const blob = await response.json() as { content?: unknown; encoding?: unknown };
    if (blob.encoding === "base64" && typeof blob.content === "string") return fromBase64(blob.content);
    throw new WorkspaceError(`[vitehub] GitHub workspace request for ${repository} returned unsupported byte response.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function findGitHubRemoteFiles(
  tree: GitHubTreeResponse,
  root: string,
  kind: "publisher" | "store",
): Map<string, GitHubTreeEntry> {
  if (tree.truncated) {
    throw new WorkspaceError(
      `[vitehub] GitHub workspace ${kind} could not compare the remote tree because GitHub returned a truncated tree.`,
    );
  }

  const files = new Map<string, GitHubTreeEntry>();
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.sha) continue;
    const path = workspacePathFromGitPath(entry.path, root);
    if (path) files.set(path, entry);
  }
  return files;
}

export async function readGitHubBranchState(input: {
  branch: string;
  kind: "publisher" | "store";
  repository: string;
  root: string;
  token: string;
}): Promise<GitHubBranchState> {
  const { owner, repo } = splitGitHubRepository(input.repository, input.kind);
  let branchExists = true;
  let ref: { object: { sha: string } };
  try {
    ref = await requestGitHubJson(
      input.repository,
      input.token,
      `/repos/${owner}/${repo}/git/ref/heads/${input.branch}`,
    );
  }
  catch (error) {
    if (!(error instanceof GitHubRequestError) || error.status !== 404) throw error;
    const repository = await requestGitHubJson<{ default_branch: string }>(
      input.repository,
      input.token,
      `/repos/${owner}/${repo}`,
    );
    ref = await requestGitHubJson(
      input.repository,
      input.token,
      `/repos/${owner}/${repo}/git/ref/heads/${repository.default_branch}`,
    );
    branchExists = false;
  }
  const current = await requestGitHubJson<{ tree: { sha: string } }>(
    input.repository,
    input.token,
    `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`,
  );
  const tree = await requestGitHubJson<GitHubTreeResponse>(
    input.repository,
    input.token,
    `/repos/${owner}/${repo}/git/trees/${current.tree.sha}?recursive=1`,
  );
  return {
    branchExists,
    files: findGitHubRemoteFiles(tree, input.root, input.kind),
    refSha: ref.object.sha,
    treeSha: current.tree.sha,
  };
}

export async function readGitHubBlob(input: {
  kind: "publisher" | "store";
  repository: string;
  sha: string;
  token: string;
}): Promise<Uint8Array> {
  const { owner, repo } = splitGitHubRepository(input.repository, input.kind);
  return await requestGitHubBytes(
    input.repository,
    input.token,
    `/repos/${owner}/${repo}/git/blobs/${input.sha}`,
  );
}

export async function commitGitHubChanges(input: {
  baseTreeSha: string;
  branch: string;
  branchExists: boolean;
  deletePaths: string[];
  files: GitHubFileUpdate[];
  kind?: "publisher" | "store";
  message: string;
  parentSha: string;
  repository: string;
  token: string;
}): Promise<GitHubCommitResult> {
  const kind = input.kind || "store";
  const { owner, repo } = splitGitHubRepository(input.repository, kind);
  const blobs = await Promise.all(
    input.files.map((file) =>
      file.bytes
        ? createGitHubBlob({
            bytes: file.bytes,
            kind,
            repository: input.repository,
            token: input.token,
          })
        : { sha: file.gitSha },
    ),
  );
  const tree = await requestGitHubJson<{ sha: string }>(
    input.repository,
    input.token,
    `/repos/${owner}/${repo}/git/trees`,
    {
      body: JSON.stringify({
        base_tree: input.baseTreeSha,
        tree: [
          ...input.files.map((file, index) => ({
            mode: file.mode || "100644",
            path: file.fullPath,
            sha: blobs[index]!.sha,
            type: "blob",
          })),
          ...input.deletePaths.map((path) => ({ mode: "100644", path, sha: null, type: "blob" })),
        ],
      }),
      method: "POST",
    },
  );
  const commit = await requestGitHubJson<{ sha: string }>(
    input.repository,
    input.token,
    `/repos/${owner}/${repo}/git/commits`,
    {
      body: JSON.stringify({
        message: input.message,
        parents: [input.parentSha],
        tree: tree.sha,
      }),
      method: "POST",
    },
  );
  if (input.branchExists) {
    await requestGitHubJson(
      input.repository,
      input.token,
      `/repos/${owner}/${repo}/git/refs/heads/${input.branch}`,
      {
        body: JSON.stringify({ force: false, sha: commit.sha }),
        method: "PATCH",
      },
    );
  }
  else {
    await requestGitHubJson(
      input.repository,
      input.token,
      `/repos/${owner}/${repo}/git/refs`,
      {
        body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: commit.sha }),
        method: "POST",
      },
    );
  }
  return { commitSha: commit.sha, treeSha: tree.sha };
}

export async function createGitHubBlob(input: {
  bytes: Uint8Array;
  kind?: "publisher" | "store";
  repository: string;
  token: string;
}): Promise<{ sha: string }> {
  const kind = input.kind || "store";
  const { owner, repo } = splitGitHubRepository(input.repository, kind);
  return await requestGitHubJson<{ sha: string }>(
    input.repository,
    input.token,
    `/repos/${owner}/${repo}/git/blobs`,
    {
      body: JSON.stringify({ content: toBase64(input.bytes), encoding: "base64" }),
      method: "POST",
    },
  );
}

export async function createGitHubFileUpdate(
  path: string,
  root: string,
  content: string | Uint8Array,
): Promise<GitHubFileUpdate & { bytes: Uint8Array }> {
  const bytes = contentToBytes(content);
  return {
    bytes,
    fullPath: joinGitPath(root, path),
    gitSha: await gitBlobSha(bytes),
  };
}
