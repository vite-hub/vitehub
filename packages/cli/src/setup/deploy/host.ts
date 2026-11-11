import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { delimiter } from "node:path"
import process from "node:process"

import { dirname, join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { isRecord } from "@vite-hub/internal/object"

import type { HostCredentials } from "@vite-hub/internal/host-credentials"
import type { SetupLink } from "../link.ts"

/** The hosts that `vitehub deploy` deploys to. */
export type DeployHost = "cloudflare" | "vercel" | "netlify" | "deno"

/** The git commit of the deployed source. A folder without git has none. */
export interface DeployCommit {
  sha: string
  dirty: boolean
}

export interface DeployRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface DeployRunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written to the child's stdin, then stdin closes. Secrets go here, never in `args`. */
  stdin?: string
  /** Copies the child's output, line by line and redacted, to the CLI's stderr. */
  show?: boolean
  /** Stops the child after this many milliseconds. Its result then has a `null` exit code. */
  timeoutMs?: number
  /** Cancels the child with the rest of a bounded host lookup. */
  signal?: AbortSignal
}

/** Runs a host CLI with an argument array and no shell. */
export type DeployRun = (command: string, args: readonly string[], options: DeployRunOptions) => Promise<DeployRunResult>

/** What a host adapter reads. */
export interface DeployContext {
  root: string
  /** The folder that holds `deployment.json`. */
  outputDir: string
  /** The project name on the host: the link, else the build identity. */
  projectName: string
  link: SetupLink | undefined
  credentials: HostCredentials
  env: NodeJS.ProcessEnv
  preview: boolean
  temporary: boolean
  commit: DeployCommit | undefined
  run: DeployRun
  fetch: typeof fetch
  /** Values that no output may show, such as the Console hash. */
  secrets: readonly string[]
}

export interface DeployResult {
  url: string
  deploymentId?: string
  version?: string
  /** The claim link of a temporary deploy. */
  claim?: { url: string, expiresAt?: string }
  /** The project on the host, when the deploy reports it. */
  project?: { id?: string, name: string, accountId?: string }
}

/** One host. */
export interface DeployAdapter {
  deploy: () => Promise<DeployResult>
}

/** Where a deployment came from, when the host says. */
export type HostDeploymentSource = "cli" | "git" | "dashboard" | "api" | "unknown"

/** One deployment as the host lists it. */
export interface HostDeployment {
  id: string
  /** The URL of this deployment. Absent when the host gives it no own URL. */
  url?: string
  createdAt: string
  state: "ready" | "building" | "error" | "canceled" | "unknown"
  target: "production" | "preview"
  /** True for the deployment that receives production traffic. */
  live: boolean
  /** The Worker version of a Cloudflare deployment. */
  version?: string
  /**
   * The deployed commit. `from: "vitehub"` is the marker of `vitehub deploy`. `from: "host"` is the commit of a Git
   * integration build, which builds a clean checkout.
   */
  commit?: DeployCommit & { from: "vitehub" | "host" }
  source: HostDeploymentSource
}

/** What a host listing reads. The link names the host project, and the credentials resolved. */
export interface DeploymentsContext {
  root: string
  link: SetupLink
  credentials: Extract<HostCredentials, { ok: true }>
  env: NodeJS.ProcessEnv
  run: DeployRun
  fetch: typeof fetch
  /** Stops each host CLI run after this many milliseconds. */
  timeoutMs?: number
}

/** Lists the newest `limit` deployments. Status can also request the live record outside that history window. */
export type ListDeployments = (context: DeploymentsContext, options: { limit: number, includeLive?: boolean }) => Promise<HostDeployment[]>

/** Replaces every value in `secrets` with `<redacted>`. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => secret ? result.replaceAll(secret, "<redacted>") : result, text)
}

/**
 * The default runner. It never uses a shell, so no argument is parsed again. Shown output is redacted per line, so a
 * value split across two chunks is still found.
 */
export function createDeployRun(stderr: { write: (chunk: string) => unknown }, secrets: readonly string[]): DeployRun {
  return (command, args, options) => new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"], ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}), ...(options.signal ? { signal: options.signal } : {}) })
    const output = { stderr: "", stdout: "" }
    const pending = { stderr: "", stdout: "" }
    const show = (stream: "stderr" | "stdout", chunk: string, flush = false) => {
      if (!options.show) return
      pending[stream] += chunk
      const end = flush ? pending[stream].length : pending[stream].lastIndexOf("\n") + 1
      if (end === 0) return
      stderr.write(redact(pending[stream].slice(0, end), secrets))
      pending[stream] = pending[stream].slice(end)
    }
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8")
      child[stream].on("data", (chunk: string) => {
        output[stream] += chunk
        show(stream, chunk)
      })
    }
    child.on("error", reject)
    child.on("close", (exitCode) => {
      show("stdout", "", true)
      show("stderr", "", true)
      resolve({ exitCode, stdout: redact(output.stdout, secrets), stderr: redact(output.stderr, secrets) })
    })
    // A CLI that exits before it reads stdin closes the pipe. That is not an error of the deploy.
    child.stdin.on("error", () => {})
    child.stdin.end(options.stdin ?? "")
  })
}

/** Resolve npm/pnpm Windows shims to Node entrypoints without evaluating any batch or shell syntax. */
function windowsNodeEntry(file: string): readonly [string, string] | undefined {
  if (/\.(?:exe|cmd|bat)$/iu.test(file)) return
  if (!existsSync(file)) return
  const source = readFileSync(file, "utf8")
  if (/\.[cm]?js$/iu.test(file) || /^#![^\r\n]*\bnode(?:\.exe)?(?:\s|$)/u.test(source)) return [process.execPath, file]
}

function executableIn(folder: string, name: string, platform: NodeJS.Platform): readonly [string, ...string[]] | undefined {
  const file = join(folder, name)
  if (platform !== "win32") return existsSync(file) ? [file] : undefined
  if (existsSync(`${file}.exe`)) return [`${file}.exe`]
  const shim = `${file}.cmd`
  if (existsSync(shim)) {
    // npm uses %dp0%; pnpm and Yarn use %~dp0. Only use existing Node files relative to the shim.
    for (const match of readFileSync(shim, "utf8").matchAll(/"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+)"/giu)) {
      const entry = windowsNodeEntry(join(folder, match[1]!.replaceAll("\\", "/")))
      if (entry) return entry
    }
  }
  return windowsNodeEntry(file)
}

/**
 * The host CLI as a command and its first arguments: the project's `node_modules/.bin` (walking up), then `PATH`,
 * then `npx --yes <package>`, which the build output also names.
 */
export function hostCli(name: string, npmPackage: string, root: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): readonly [string, ...string[]] {
  for (let folder = root; ; folder = dirname(folder)) {
    const found = executableIn(join(folder, "node_modules", ".bin"), name, platform)
    if (found) return found
    if (dirname(folder) === folder) break
  }
  const path = (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean)
  for (const folder of path) {
    const found = executableIn(folder, name, platform)
    if (found) return found
  }
  if (platform === "win32") {
    for (const folder of [...path, dirname(process.execPath)]) {
      const npx = executableIn(folder, "npx", platform)
      if (npx) return [...npx, "--yes", npmPackage]
    }
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_FAILED({ exitCode: null, output: "Could not find a Node.js entrypoint for npx. Install Node.js with npm or install the host CLI locally.", step: "npx" }), setupExitCodes.error)
  }
  return ["npx", "--yes", npmPackage]
}

/**
 * Splits a command that the build wrote into words, the way a POSIX shell reads plain words and single quotes.
 * Anything a shell would expand or run (`$`, backquotes, `;`, `|`, `&`, `<`, `>`, `(`, `)`, double quotes, `\`) is
 * rejected, so the words are exactly what the build meant.
 */
export function splitManifestCommand(command: string): string[] {
  const words: string[] = []
  let word: string | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === "'") {
      const end = command.indexOf("'", index + 1)
      if (end === -1) throw commandRejected(command)
      word = (word ?? "") + command.slice(index + 1, end)
      index = end
    }
    else if (char === " " || char === "\t") {
      if (word !== undefined) words.push(word)
      word = undefined
    }
    else if (/[$`;|&<>()"\\\n*?~#{}]/u.test(char)) throw commandRejected(command)
    else word = (word ?? "") + char
  }
  if (word !== undefined) words.push(word)
  return words
}

export function commandRejected(command: string): SetupFailure {
  return new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_COMMAND_REJECTED({ command }), setupExitCodes.error)
}

/** A host CLI that exited with an error. Its last lines go into the reason, redacted. */
export function hostCliFailed(step: string, result: DeployRunResult, secrets: readonly string[]): SetupFailure {
  const lines = redact(`${result.stderr}\n${result.stdout}`, secrets).split("\n").map(line => line.trimEnd()).filter(Boolean).slice(-6).join("\n")
  return new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_FAILED({ exitCode: result.exitCode, output: lines, step }), setupExitCodes.error)
}

/** The last JSON object in `text`. Host CLIs may print a line before it. */
export function lastJsonObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.lastIndexOf("{"); start !== -1; start = text.lastIndexOf("{", start - 1)) {
    try {
      const value: unknown = JSON.parse(text.slice(start))
      if (isRecord(value)) return value
    }
    catch {}
  }
}

export { isRecord }

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The first `https://` URL in `text` that matches `host`, else undefined. */
export function findUrl(text: string, host: RegExp): string | undefined {
  for (const match of text.matchAll(/https:\/\/[^\s"'`<>)\]]+/gu)) {
    const url = match[0].replace(/[.,;]+$/u, "")
    if (host.test(new URL(url).hostname)) return url
  }
}

/** The `vitehub:` marker that Cloudflare and Netlify store as the deploy message. */
export function commitMessage(commit: DeployCommit): string {
  return `vitehub:${JSON.stringify({ commit: commit.sha, dirty: commit.dirty })}`
}

/** Reads the `vitehub:` marker of `commitMessage`. Returns undefined for any other message. */
export function parseCommitMessage(message: unknown): DeployCommit | undefined {
  if (typeof message !== "string" || !message.startsWith("vitehub:")) return
  let value: unknown
  try {
    value = JSON.parse(message.slice("vitehub:".length))
  }
  catch {
    return
  }
  if (!isRecord(value) || typeof value.commit !== "string" || !/^[0-9a-f]{40,64}$/u.test(value.commit)) return
  return { dirty: value.dirty === true, sha: value.commit }
}

/** A host time, such as an ISO string or a millisecond timestamp, as an ISO string. */
export function isoTime(value: unknown): string {
  const time = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : ""
}

/** Reads the commit with git, using argument arrays. Returns undefined without git or outside a repository. */
export async function readDeployCommit(run: DeployRun, root: string, env: NodeJS.ProcessEnv): Promise<DeployCommit | undefined> {
  try {
    const head = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, env })
    const sha = head.stdout.trim()
    if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(sha)) return
    const status = await run("git", ["status", "--porcelain"], { cwd: root, env })
    return { dirty: status.exitCode !== 0 || status.stdout.trim() !== "", sha }
  }
  catch {
    return
  }
}
