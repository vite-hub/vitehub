import { Buffer } from "node:buffer"
import { devNull } from "node:os"

import { normalizeSourcePath } from "../../core/path.ts"

import type { GitHubFile } from "./types.ts"

interface GitOptions {
  env?: NodeJS.ProcessEnv
  input?: string
  signal?: AbortSignal
}

type GitRunner = (args: string[], options?: GitOptions) => Promise<string | Uint8Array>

interface GitCheckoutInput<TKey extends string> {
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
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key]
  }
  delete env.GIT_CONFIG_PARAMETERS

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
    child.stdin.end(options.input)
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

interface GitTreeEntry<TKey extends string> {
  key: TKey
  oid: string
}

function parseGitTree<TKey extends string>(
  output: Uint8Array,
  input: GitCheckoutInput<TKey>,
): GitTreeEntry<TKey>[] {
  return Buffer.from(output).toString("utf8").split("\0")
    .filter(Boolean)
    .map((record): GitTreeEntry<TKey> | undefined => {
      const tab = record.indexOf("\t")
      if (tab === -1) return
      const [mode, type, oid] = record.slice(0, tab).split(" ")
      if (!mode?.startsWith("100") || type !== "blob" || !oid) return
      const repoPath = record.slice(tab + 1)
      const key = input.keyForRepoPath(repoPath)
      if (!key || !input.shouldInclude(key)) return
      return { key, oid }
    })
    .filter(entry => entry !== undefined)
}

function parseGitBlobs(output: Uint8Array, oids: string[]) {
  const bytes = Buffer.from(output)
  const blobs = new Map<string, Buffer>()
  let offset = 0

  for (const expectedOid of oids) {
    const newline = bytes.indexOf(10, offset)
    if (newline === -1) throw new Error("git cat-file returned a truncated header.")
    const [oid, type, rawSize] = bytes.subarray(offset, newline).toString("ascii").split(" ")
    const size = Number(rawSize)
    if (oid !== expectedOid || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("git cat-file returned an unexpected object.")
    }
    const contentStart = newline + 1
    const contentEnd = contentStart + size
    if (contentEnd >= bytes.length || bytes[contentEnd] !== 10) {
      throw new Error("git cat-file returned truncated object content.")
    }
    blobs.set(oid, Buffer.from(bytes.subarray(contentStart, contentEnd)))
    offset = contentEnd + 1
  }

  return blobs
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

async function readGitFiles<TKey extends string>(
  dir: string,
  input: GitCheckoutInput<TKey> & { sha: string },
  executeGit: GitRunner,
  options: GitOptions,
): Promise<GitHubFile<TKey>[]> {
  input.signal?.throwIfAborted()
  const treeOutput = await executeGit([
    "-C",
    dir,
    "ls-tree",
    "-r",
    "-z",
    input.sha,
    "--",
    ...input.sparsePatterns.map(pattern => pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern),
  ], options)
  const entries = parseGitTree(Buffer.from(treeOutput), input)
  const oids = [...new Set(entries.map(entry => entry.oid))]
  if (!oids.length) return []

  input.signal?.throwIfAborted()
  const blobOutput = await executeGit(["-C", dir, "cat-file", "--batch"], {
    ...options,
    input: `${oids.join("\n")}\n`,
  })
  const blobs = parseGitBlobs(Buffer.from(blobOutput), oids)
  return entries.map(entry => ({
    content: blobs.get(entry.oid),
    key: entry.key,
    path: entry.key,
    ref: input.ref,
    sha: input.sha,
  }))
}

export async function loadGitCheckoutFiles<TKey extends string>(
  input: GitCheckoutInput<TKey>,
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
    return await readGitFiles(dir, { ...input, sha }, executeGit, options)
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}
