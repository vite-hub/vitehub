import { Buffer } from "node:buffer"
import { devNull } from "node:os"

import { normalizeSourcePath } from "../../core/path.ts"
import { parseGitHubArchive } from "./archive.ts"

import type { GitHubFile } from "./types.ts"

interface GitOptions {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

type GitRunner = (args: string[], options?: GitOptions) => Promise<string | Uint8Array>

interface GitArchiveInput<TKey extends string> {
  env?: NodeJS.ProcessEnv
  keyForRepoPath: (path: string) => TKey | undefined
  ref: string
  repo: string
  repositoryUrl?: string
  shouldInclude: (key: TKey) => boolean
  signal?: AbortSignal
  sparsePatterns: string[]
  token?: string
}

function createGitEnv(home: string, token?: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv }
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
  ]) {
    delete env[key]
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key]
  }

  Object.assign(env, {
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "",
    GIT_CONFIG_COUNT: token ? "1" : "0",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    SSH_ASKPASS: "",
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
  })

  if (!token) return env
  const credential = Buffer.from(`x-access-token:${token}`).toString("base64")
  env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader"
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${credential}`
  return env
}

async function runGit(args: string[], options: GitOptions = {}): Promise<Uint8Array> {
  const { spawn } = await import("node:child_process")
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    child.stdout.on("data", chunk => stdout.push(chunk))
    child.stderr.resume()
    child.stdin.on("error", () => {})
    child.stdin.end()
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout))
        return
      }
      const command = args[0] === "-C" ? args[2] : args[0]
      reject(new Error(`git ${command || "command"} exited with ${code ?? "an unknown status"}.`))
    })
  })
}

function isGitSparsePattern(pattern: string) {
  if (pattern.includes("\0") || pattern.includes("\r") || pattern.includes("\n")) return false
  const segments = pattern.split("/")
  if (segments.some(segment => segment === "." || segment === "..")) return false
  if (!pattern.includes("*")) return !/[?[\]{}()!+@]/.test(pattern)
  if (!pattern.endsWith("/**")) return false
  return !/[*?[\]{}()!+@]/.test(pattern.slice(0, -3))
}

export function getGitSparsePatterns(root: string, include?: string | string[]): string[] | undefined {
  const patterns = (include ? (Array.isArray(include) ? include : [include]) : [])
    .map(pattern => [root, normalizeSourcePath(pattern)].filter(Boolean).join("/"))
    .filter(Boolean)
  if (patterns.some(pattern => !isGitSparsePattern(pattern))) return
  if (patterns.length) return [...new Set(patterns)]
  return root && isGitSparsePattern(root) ? [`${root}/**`] : undefined
}

function isGitLfsPointer(content: Uint8Array) {
  if (content.byteLength > 64 * 1024) return false
  const lines = Buffer.from(content).toString("utf8").split(/\r?\n/)
  return lines[0] === "version https://git-lfs.github.com/spec/v1"
    && lines.some(line => /^oid sha256:[0-9a-f]{64}$/.test(line))
    && lines.some(line => /^size \d+$/.test(line))
}

async function readGitArchiveFiles<TKey extends string>(
  dir: string,
  input: GitArchiveInput<TKey> & { sha: string },
  executeGit: GitRunner,
  options: GitOptions,
): Promise<GitHubFile<TKey>[]> {
  input.signal?.throwIfAborted()
  const archive = await executeGit([
    "-C",
    dir,
    "archive",
    "--format=tar.gz",
    "--prefix=archive/",
    input.sha,
    "--",
    ...input.sparsePatterns.map((pattern) => {
      const path = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern
      return `:(literal)${path}`
    }),
  ], options)
  return parseGitHubArchive(Buffer.from(archive))
    .map((entry): GitHubFile<TKey> | undefined => {
      const key = input.keyForRepoPath(entry.path)
      if (!key || !input.shouldInclude(key)) return
      if (isGitLfsPointer(entry.content)) {
        throw new Error("git archive contained a Git LFS pointer; use the GitHub archive instead.")
      }
      return {
        content: entry.content,
        key,
        path: key,
        ref: input.ref,
        sha: input.sha,
      }
    })
    .filter((file): file is GitHubFile<TKey> => Boolean(file))
}

export async function loadGitArchiveFiles<TKey extends string>(
  input: GitArchiveInput<TKey>,
  executeGit: GitRunner = runGit,
): Promise<GitHubFile<TKey>[]> {
  const [{ mkdtemp, rm }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ])
  const dir = await mkdtemp(join(tmpdir(), "vitehub-github-"))
  try {
    const env = createGitEnv(dir, input.token, input.env)
    const options = { env, signal: input.signal }
    await executeGit(["init", "--quiet", dir], options)
    await executeGit([
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      input.repositoryUrl || `https://github.com/${input.repo}.git`,
    ], options)
    await executeGit(["-C", dir, "config", "remote.origin.promisor", "true"], options)
    await executeGit(["-C", dir, "config", "remote.origin.partialclonefilter", "blob:none"], options)
    await executeGit([
      "-C",
      dir,
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "--",
      "origin",
      `+${input.ref}`,
    ], options)
    const sha = Buffer.from(await executeGit(["-C", dir, "rev-parse", "FETCH_HEAD"], options)).toString("utf8").trim()
    return await readGitArchiveFiles(dir, { ...input, sha }, executeGit, options)
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}
