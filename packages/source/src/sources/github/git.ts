import { Buffer } from "node:buffer"

import { normalizeSourcePath } from "../../core/path.ts"

import type { GitHubFile } from "./types.ts"

interface GitOptions {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

type GitRunner = (args: string[], options?: GitOptions) => Promise<string>

interface GitCheckoutInput<TKey extends string> {
  keyForRepoPath: (path: string) => TKey | undefined
  ref?: string
  repo: string
  shouldInclude: (key: TKey) => boolean
  signal?: AbortSignal
  sparsePatterns: string[]
  token?: string
}

function createGitEnv(token?: string): NodeJS.ProcessEnv {
  if (!token) return process.env
  const configCount = /^\d+$/.test(process.env.GIT_CONFIG_COUNT || "")
    ? Number(process.env.GIT_CONFIG_COUNT)
    : 0
  const credential = Buffer.from(`x-access-token:${token}`).toString("base64")
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(configCount + 1),
    [`GIT_CONFIG_KEY_${configCount}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${configCount}`]: `AUTHORIZATION: basic ${credential}`,
  }
}

async function runGit(args: string[], options: GitOptions = {}): Promise<string> {
  const { spawn } = await import("node:child_process")
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: options.env,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    child.stdout.on("data", chunk => stdout.push(chunk))
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"))
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
    .map(pattern => normalizeSourcePath(root ? `${root}/${pattern}` : pattern))
    .filter(Boolean)
  if (patterns.some(pattern => !isGitSparsePattern(pattern))) return
  if (patterns.length) return [...new Set(patterns)]
  return root && isGitSparsePattern(root) ? [`${root}/**`] : undefined
}

async function readCheckoutFiles<TKey extends string>(
  dir: string,
  input: GitCheckoutInput<TKey> & { sha: string },
): Promise<GitHubFile<TKey>[]> {
  const [{ readdir, readFile }, { join, relative }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ])
  const files: GitHubFile<TKey>[] = []

  async function walk(current: string): Promise<void> {
    input.signal?.throwIfAborted()
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      if (entry.name === ".git") continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const repoPath = relative(dir, path).replaceAll("\\", "/")
      const key = input.keyForRepoPath(repoPath)
      if (!key || !input.shouldInclude(key)) continue
      input.signal?.throwIfAborted()
      files.push({
        content: await readFile(path),
        key,
        path: key,
        sha: input.sha,
      })
    }
  }

  await walk(dir)
  return files
}

export async function loadGitCheckoutFiles<TKey extends string>(
  input: GitCheckoutInput<TKey>,
  executeGit: GitRunner = runGit,
): Promise<GitHubFile<TKey>[]> {
  const [{ mkdir, mkdtemp, rm, writeFile }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ])
  const dir = await mkdtemp(join(tmpdir(), "vitehub-github-"))
  try {
    const env = createGitEnv(input.token)
    const options = { env, signal: input.signal }
    await executeGit(["init", "--quiet", dir], options)
    await executeGit(["-C", dir, "remote", "add", "origin", `https://github.com/${input.repo}.git`], options)
    await executeGit(["-C", dir, "config", "core.sparseCheckout", "true"], options)
    await executeGit(["-C", dir, "config", "core.sparseCheckoutCone", "false"], options)
    await mkdir(join(dir, ".git", "info"), { recursive: true })
    await writeFile(
      join(dir, ".git", "info", "sparse-checkout"),
      `${input.sparsePatterns.map(pattern => `/${pattern}`).join("\n")}\n`,
    )
    await executeGit([
      "-C",
      dir,
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      input.ref ? `+${input.ref}` : "HEAD",
    ], options)
    await executeGit(["-C", dir, "checkout", "--quiet", "--detach", "FETCH_HEAD"], options)
    const sha = (await executeGit(["-C", dir, "rev-parse", "HEAD"], options)).trim()
    return await readCheckoutFiles(dir, { ...input, sha })
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}
