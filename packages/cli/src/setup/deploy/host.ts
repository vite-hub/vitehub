import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter } from "node:path"

import { dirname, join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"

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

/**
 * One host. `setSecret` sends the value over stdin or in a JSON request body, never in argv.
 * `setTemporaryVar` writes a plain runtime var into the build output, for a temporary deploy that has no account.
 */
export interface DeployAdapter {
  deploy: () => Promise<DeployResult>
  setSecret: (name: string, value: string) => Promise<void>
  hasSecret: (name: string) => Promise<boolean>
  /** False when the host project does not exist yet, so a secret has no place to go before the first deploy. */
  projectExists: () => Promise<boolean>
  setTemporaryVar?: (name: string, value: string) => Promise<void>
}

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
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"] })
    const output = { stderr: "", stdout: "" }
    let pending = ""
    const show = (chunk: string, flush = false) => {
      if (!options.show) return
      pending += chunk
      const end = flush ? pending.length : pending.lastIndexOf("\n") + 1
      if (end === 0) return
      stderr.write(redact(pending.slice(0, end), secrets))
      pending = pending.slice(end)
    }
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8")
      child[stream].on("data", (chunk: string) => {
        output[stream] += chunk
        show(chunk)
      })
    }
    child.on("error", reject)
    child.on("close", (exitCode) => {
      show("", true)
      resolve({ exitCode, ...output })
    })
    // A CLI that exits before it reads stdin closes the pipe. That is not an error of the deploy.
    child.stdin.on("error", () => {})
    child.stdin.end(options.stdin ?? "")
  })
}

function executableIn(folder: string, name: string): string | undefined {
  const file = join(folder, name)
  return existsSync(file) ? file : undefined
}

/**
 * The host CLI as a command and its first arguments: the project's `node_modules/.bin` (walking up), then `PATH`,
 * then `npx --yes <package>`, which the build output also names.
 */
export function hostCli(name: string, npmPackage: string, root: string, env: NodeJS.ProcessEnv): readonly [string, ...string[]] {
  for (let folder = root; ; folder = dirname(folder)) {
    const found = executableIn(join(folder, "node_modules", ".bin"), name)
    if (found) return [found]
    if (dirname(folder) === folder) break
  }
  for (const folder of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const found = executableIn(folder, name)
    if (found) return [found]
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** True when `value` or a nested object has `key: name`, such as an env var list. */
export function listsName(value: unknown, keys: readonly string[], name: string): boolean {
  if (Array.isArray(value)) return value.some(item => listsName(item, keys, name))
  if (!isRecord(value)) return false
  if (keys.some(key => value[key] === name)) return true
  return Object.values(value).some(item => typeof item === "object" && listsName(item, keys, name))
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
