import {
  defineCapability,
  normalizeMode,
} from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"
import type { WorkspaceSession } from "@vite-hub/workspace"
import type { JSONSchema7 } from "json-schema"

export type GitCapabilityToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface GitCapabilityOptions {
  maxOutputLength?: number
  mode?: AgentCapabilityMode
  policy?: GitCapabilityToolPolicy
  timeout?: number
}

interface GitCommandInput {
  args?: string[]
  cmd?: string
  command?: string
  cwd?: string
}

interface GitCommandResult {
  args: string[]
  command: string
  cwd: string
  exitCode: number
  outputTruncated?: boolean
  stderr: string
  stdout: string
}

interface GitSessionState {
  sessionPromises?: Map<string, Promise<GitSessionHandle>>
}

interface GitSessionHandle {
  commitWrites: boolean
  session: WorkspaceSession
}

const readSubcommands = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "merge-base",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
])
const writeSubcommands = new Set(["checkout", "fetch", "switch"])
const blockedSubcommands = new Set(["commit", "push", "reset", "rebase", "tag"])
const blockedReadOptions = new Set(["--contents", "--ext-diff", "--no-index", "--open-files-in-pager", "--textconv"])
const blockedCheckoutOptions = new Set(["--force", "--merge", "--orphan", "--patch", "-B", "-b", "-f", "-m", "-p"])
const blockedFetchOptions = new Set(["--force", "--prune-tags", "--refmap", "--tags", "--update-head-ok", "--upload-pack", "-P", "-f", "-t", "-u"])
const fetchOptionsWithValue = new Set(["--deepen", "--depth", "--filter", "--jobs", "--negotiation-tip", "--refmap", "--recurse-submodules", "--server-option", "--shallow-exclude", "--shallow-since", "--upload-pack"])
const blockedSwitchOptions = new Set(["--create", "--discard-changes", "--force", "--force-create", "--guess", "--merge", "--orphan", "--track", "-C", "-c", "-f", "-m", "-t"])
const defaultMaxOutputLength = Number.POSITIVE_INFINITY
const defaultTimeout = 60_000
const gitEnv = {
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  PAGER: "cat",
}
const githubRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const gitRefPattern = /^[A-Za-z0-9._/-]+$/

type GitSessionWorkspace = {
  startSession: (options?: { paths?: readonly string[] }) => Promise<WorkspaceSession>
}

function isGitSessionWorkspace(workspace: unknown): workspace is GitSessionWorkspace {
  return typeof workspace === "object"
    && workspace !== null
    && typeof (workspace as { startSession?: unknown }).startSession === "function"
}

function parseGitCommand(command: string): string[] {
  const words = shellWords(command)
  if (words[0] !== "git") throw new Error("[vitehub] git commands must start with `git`.")
  if (!words[1]) throw new Error("[vitehub] git command requires a subcommand.")
  if (words[1].startsWith("-")) throw new Error("[vitehub] git() does not accept global git flags. The tool cwd option provides repository scoping without `git -C`.")
  return words.slice(1)
}

function shellWords(command: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (char === "|" || char === ";" || char === "<" || char === ">" || char === "&" || char === "\n") {
      throw new Error("[vitehub] git() accepts one git command without shell composition.")
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (escaped) current += "\\"
  if (quote) throw new Error("[vitehub] git() command has an unterminated quote.")
  if (current) words.push(current)
  return words
}

function assertGitRead(args: string[]): void {
  const subcommand = args[0]!
  if (blockedSubcommands.has(subcommand)) {
    throw new Error(`[vitehub] git ${subcommand} is not available through git().`)
  }
  if (!readSubcommands.has(subcommand)) {
    throw new Error(`[vitehub] git ${subcommand} requires git({ mode: "write" }) or is not supported.`)
  }
  if (args.some(arg => arg === "--output" || arg.startsWith("--output="))) {
    throw new Error("[vitehub] git read commands cannot write output files.")
  }
  for (const arg of args.slice(1)) {
    const option = optionName(arg)
    if (blockedReadOptions.has(option) || arg === "-O" || arg.startsWith("-O")) {
      throw new Error(`[vitehub] git ${subcommand} option ${option} is not available through the controlled git shell.`)
    }
    assertWorkspaceArg(arg)
  }
}

function assertGitWrite(args: string[]): void {
  const subcommand = args[0]!
  if (!writeSubcommands.has(subcommand)) {
    assertGitRead(args)
    return
  }
  if (subcommand === "fetch" && args.some(arg => arg.includes("://") || arg.startsWith("git@"))) {
    throw new Error("[vitehub] git fetch only accepts configured remotes, not arbitrary remote URLs.")
  }
  if (subcommand === "fetch") assertGitFetch(args)
  if (subcommand === "checkout") assertNoBlockedOptions(args, blockedCheckoutOptions)
  if (subcommand === "switch") assertNoBlockedOptions(args, blockedSwitchOptions)
}

function optionName(arg: string): string {
  const equalsIndex = arg.indexOf("=")
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex)
}

function assertWorkspaceArg(arg: string): void {
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg
  const normalized = value.replace(/\\/g, "/")
  if (normalized === ".." || normalized.startsWith("/") || normalized.startsWith("../") || normalized.startsWith("~/") || normalized.includes("/../")) {
    throw new Error("[vitehub] git arguments must stay inside the workspace.")
  }
}

function assertNoBlockedOptions(args: string[], blockedOptions: Set<string>): void {
  for (const arg of args.slice(1)) {
    const option = optionName(arg)
    if (blockedOptions.has(option) || blockedOptions.has(arg.slice(0, 2))) {
      throw new Error(`[vitehub] git ${args[0]} option ${option} is not available through the controlled git shell.`)
    }
    assertWorkspaceArg(arg)
  }
}

function assertGitFetch(args: string[]): void {
  for (const arg of args.slice(1)) {
    const option = optionName(arg)
    if (blockedFetchOptions.has(option) || blockedFetchOptions.has(arg.slice(0, 2))) {
      throw new Error(`[vitehub] git fetch option ${option} is not available through the controlled git shell.`)
    }
  }
  const [, ...refspecs] = fetchPositionals(args)
  for (const refspec of refspecs) {
    assertWorkspaceArg(refspec)
    if (refspec.startsWith("+") || refspec.includes(":")) {
      throw new Error("[vitehub] git fetch cannot update local ref destinations through the controlled git shell.")
    }
  }
}

function fetchPositionals(args: string[]): string[] {
  const positionals: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--") return positionals.concat(args.slice(index + 1))
    if (arg.startsWith("--")) {
      if (fetchOptionsWithValue.has(optionName(arg)) && !arg.includes("=")) index += 1
      continue
    }
    if (arg === "-j" || arg === "--jobs") {
      index += 1
      continue
    }
    if (arg.startsWith("-")) continue
    positionals.push(arg)
  }
  return positionals
}

function fetchRemote(args: string[]): string | undefined {
  return fetchPositionals(args)[0]
}

function gitExecOptions(cwd: string, timeout: number | undefined) {
  return { cwd, env: gitEnv, timeout }
}

function gitShellExecOptions(cwd: string, timeout: number | undefined, env: Record<string, string | undefined>) {
  return {
    cwd,
    env: {
      ...gitEnv,
      ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    },
    timeout,
  }
}

async function assertConfiguredFetchRemote(session: WorkspaceSession, cwd: string, timeout: number | undefined, args: string[]): Promise<void> {
  const remote = fetchRemote(args)
  if (!remote) return
  const result = await session.exec("git", ["remote"], gitExecOptions(cwd, timeout))
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "[vitehub] git remote failed.")
  if (!result.stdout.split(/\r?\n/).filter(Boolean).includes(remote)) {
    throw new Error("[vitehub] git fetch only accepts configured remotes, not arbitrary remote URLs.")
  }
}

function normalizeCwd(cwd: string | undefined): string {
  const stripped = (cwd || "").replace(/\\/g, "/").replace(/^\/workspace(?:\/|$)/, "")
  const parts = stripped.split("/").filter(Boolean)
  if (parts.some(part => part === "." || part === "..")) {
    throw new Error("[vitehub] git cwd must stay inside the workspace.")
  }
  return parts.length ? `/workspace/${parts.join("/")}` : "/workspace"
}

function workspacePathFromGitCwd(cwd: string): string {
  return cwd.replace(/^\/workspace(?:\/|$)/, "")
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function isGitRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeGitHubRepository(repo: unknown): string | undefined {
  return typeof repo === "string" && githubRepositoryPattern.test(repo) ? repo : undefined
}

function safeGitRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref || ref.length > 250) return
  if (!gitRefPattern.test(ref) || ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith(".lock") || ref.endsWith("/") || ref.startsWith("/")) return
  return ref
}

function safeGitSha(sha: unknown): string | undefined {
  if (typeof sha !== "string") return
  const normalized = sha.toLowerCase()
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized) ? normalized : undefined
}

function safeWorkspacePath(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return
  try {
    return workspacePathFromGitCwd(normalizeCwd(path)) || undefined
  }
  catch {
    return
  }
}

function gitRemoteRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`
}

function gitRemoteBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "")
}

function gitRemoteBranchTrackingRef(ref: string): string {
  return `refs/remotes/origin/${gitRemoteBranchRef(ref)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function gitCommandFromArgs(args: unknown): string | undefined {
  if (!Array.isArray(args) || !args.length || !args.every(arg => typeof arg === "string" && arg.length > 0)) return
  const words = args[0] === "git" ? args : ["git", ...args]
  return words.map(word => /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : shellQuote(word)).join(" ")
}

async function gitHubCliToken(): Promise<string | undefined> {
  try {
    const { execFileSync } = await import("node:child_process")
    return execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GITHUB_TOKEN" && key !== "GH_TOKEN" && key !== "VITEHUB_GITHUB_TOKEN")),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim() || undefined
  }
  catch {
    return
  }
}

async function gitHubAuthHeader(): Promise<string | undefined> {
  const token = process.env.VITEHUB_GITHUB_TOKEN || process.env.GH_TOKEN || await gitHubCliToken() || process.env.GITHUB_TOKEN
  return token ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` : undefined
}

function pullRequestGitSetup(context: { context?: { get(key: string): unknown } }) {
  const raw = context.context?.get("pullRequest")
  const pullRequest = isGitRecord(raw) && isGitRecord(raw.pullRequest) ? raw.pullRequest : isGitRecord(raw) ? raw : undefined
  if (!pullRequest) return

  const provider = isGitRecord(raw) ? raw.provider : undefined
  if (typeof provider === "string" && provider !== "github") return

  const source = isGitRecord(pullRequest.source) ? pullRequest.source : undefined
  const base = isGitRecord(pullRequest.base) ? pullRequest.base : undefined
  const head = isGitRecord(pullRequest.head) ? pullRequest.head : undefined
  const repository = isGitRecord(raw) && isGitRecord(raw.repository) ? raw.repository : undefined
  const repo = safeGitHubRepository(source?.repo)
    || safeGitHubRepository(isGitRecord(raw) ? raw.repository : undefined)
    || safeGitHubRepository(repository?.fullName)
  const mount = safeWorkspacePath(source?.mount) || safeWorkspacePath(repository?.name)
  const headRef = safeGitRef(source?.ref) || safeGitRef(head?.ref) || safeGitRef(pullRequest.headRef)
  const baseRef = safeGitRef(base?.ref) || safeGitRef(pullRequest.baseRef)
  if (!repo || !mount || !headRef) return
  const headSha = safeGitSha(head?.sha) || safeGitSha(pullRequest.headSha)
  if (!headSha) throw new Error("[vitehub] GitHub pull request checkout requires an exact head SHA.")

  return {
    ...(baseRef ? { baseRef: gitRemoteRef(baseRef) } : {}),
    headRef: gitRemoteRef(headRef),
    headSha,
    mount,
    remoteUrl: `https://github.com/${repo}.git`,
  }
}

function gitSessionWorkspacePath(cwd: string, context: { context?: { get(key: string): unknown } }): string {
  const workspacePath = workspacePathFromGitCwd(cwd)
  const setup = pullRequestGitSetup(context)
  if (setup && pathContains(setup.mount, workspacePath)) return setup.mount
  return ""
}

async function preparePullRequestGitSession(
  session: WorkspaceSession,
  workspacePath: string,
  context: { context?: { get(key: string): unknown } },
  timeout: number | undefined,
): Promise<boolean> {
  const setup = pullRequestGitSetup(context)
  if (!setup || workspacePath !== setup.mount) return false

  const cwd = `/workspace/${setup.mount}`
  const existing = await session.exec("git", ["rev-parse", "--is-inside-work-tree"], gitExecOptions(cwd, timeout))
  if (existing.exitCode === 0) {
    const head = await session.exec("git", ["rev-parse", "HEAD"], gitExecOptions(cwd, timeout))
    if (head.exitCode !== 0 || head.stdout.trim().toLowerCase() !== setup.headSha) {
      throw new Error("[vitehub] existing pull request checkout does not match the expected SHA.")
    }
    return false
  }

  const baseTrackingRef = setup.baseRef ? gitRemoteBranchTrackingRef(setup.baseRef) : undefined
  const authHeader = await gitHubAuthHeader()
  const fetchRefspecs = [
    `${setup.headRef}:refs/vitehub/head`,
    ...(setup.baseRef && baseTrackingRef ? [`${setup.baseRef}:${baseTrackingRef}`] : []),
  ].map(shellQuote).join(" ")
  const script = [
    "set -eu",
    `rm -rf -- ${shellQuote(setup.mount)}`,
    `mkdir -p -- ${shellQuote(setup.mount)}`,
    `cd -- ${shellQuote(setup.mount)}`,
    "git init -q",
    `git remote add origin ${shellQuote(setup.remoteUrl)}`,
    'if [ -n "${VITEHUB_GIT_AUTH_HEADER:-}" ]; then git config --local http.https://github.com/.extraheader "$VITEHUB_GIT_AUTH_HEADER"; fi',
    `git fetch --depth=100 origin ${fetchRefspecs}`,
    `test "$(git rev-parse refs/vitehub/head)" = ${shellQuote(setup.headSha)} || { echo "[vitehub] fetched pull request head does not match the expected SHA." >&2; exit 1; }`,
    "git checkout -q --detach refs/vitehub/head",
    ...(baseTrackingRef ? [`git branch -f vitehub-base ${shellQuote(baseTrackingRef)} >/dev/null`] : []),
    "git branch -f vitehub-head HEAD >/dev/null",
  ].join("\n")
  const result = await session.exec("sh", ["-lc", script], gitShellExecOptions("/workspace", timeout, {
    VITEHUB_GIT_AUTH_HEADER: authHeader,
  }))
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "[vitehub] git could not prepare pull request checkout.")
  }
  return true
}

function defaultGitCwd(context: { context?: { get(key: string): unknown } }): string | undefined {
  return pullRequestGitSetup(context)?.mount
}

function normalizeGitCommandString(command: string): string {
  const trimmed = command.trim()
  if (!trimmed || trimmed === "git" || trimmed.startsWith("git ")) return trimmed
  const [subcommand] = trimmed.split(/\s+/, 1)
  return readSubcommands.has(subcommand!) || writeSubcommands.has(subcommand!) ? `git ${trimmed}` : trimmed
}

function normalizeGitToolInput(input: unknown, defaultCwd: string | undefined): GitCommandInput {
  if (typeof input === "string") {
    return {
      command: normalizeGitCommandString(input),
      ...(defaultCwd ? { cwd: defaultCwd } : {}),
    }
  }
  if (!isGitRecord(input)) return {}
  const command = typeof input.command === "string"
    ? input.command
    : typeof input.cmd === "string"
      ? input.cmd
      : gitCommandFromArgs(input.args)
  return {
    ...input,
    ...(command ? { command: normalizeGitCommandString(command) } : {}),
    ...(input.cwd === undefined && defaultCwd ? { cwd: defaultCwd } : {}),
  }
}

function limitOutput(output: string, maxOutputLength: number): { output: string, truncated?: boolean } {
  if (output.length <= maxOutputLength) return { output }
  return {
    output: `${output.slice(0, maxOutputLength)}\n[output truncated to ${maxOutputLength} characters]\n`,
    truncated: true,
  }
}

async function cleanWorkingTree(session: WorkspaceSession, cwd: string, timeout: number | undefined): Promise<void> {
  const result = await session.exec("git", ["status", "--porcelain"], gitExecOptions(cwd, timeout))
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "[vitehub] git status failed.")
  if (result.stdout.trim()) throw new Error("[vitehub] git write commands require a clean working tree.")
}

function gitShellPolicy(policy: GitCapabilityToolPolicy, defaultCwd: string | undefined): GitCapabilityToolPolicy {
  return async (context) => {
    let args: string[] | undefined
    try {
      const input = normalizeGitToolInput(context.input, defaultCwd)
      args = typeof input.command === "string" ? parseGitCommand(input.command) : undefined
    }
    catch {
      return "allow"
    }
    if (!args || !writeSubcommands.has(args[0]!)) return "allow"
    if (typeof policy === "function") {
      return policy({
        ...context,
        input: normalizeGitToolInput(context.input, defaultCwd),
      })
    }
    return policy
  }
}

function gitTools(
  mode: AgentCapabilityMode,
  options: Required<Pick<GitCapabilityOptions, "maxOutputLength">> & Pick<GitCapabilityOptions, "policy" | "timeout">,
  getSession: (cwd: string) => Promise<GitSessionHandle>,
  defaultCwd: string | undefined,
): AgentToolSet {
  async function run(rawInput: unknown, write: boolean): Promise<GitCommandResult> {
    const input = normalizeGitToolInput(rawInput, defaultCwd)
    if (typeof input?.command !== "string" || !input.command.trim()) {
      throw new Error("[vitehub] git command must be a non-empty string.")
    }
    const args = parseGitCommand(input.command)
    write ? assertGitWrite(args) : assertGitRead(args)
    const cwd = normalizeCwd(input.cwd)
    const handle = await getSession(cwd)
    const { session } = handle
    if (write && args[0] === "fetch") await assertConfiguredFetchRemote(session, cwd, options.timeout, args)
    if (write && writeSubcommands.has(args[0]!)) await cleanWorkingTree(session, cwd, options.timeout)
    const result = await session.exec("git", args, gitExecOptions(cwd, options.timeout))
    if (handle.commitWrites && write && writeSubcommands.has(args[0]!) && result.exitCode === 0) {
      await session.commit({ message: `git ${args[0]}` })
    }
    const stdout = limitOutput(result.stdout, options.maxOutputLength)
    const stderr = limitOutput(result.stderr, options.maxOutputLength)
    return {
      args,
      command: input.command,
      cwd,
      exitCode: result.exitCode,
      outputTruncated: stdout.truncated || stderr.truncated,
      stderr: stderr.output,
      stdout: stdout.output,
    }
  }

  return {
    shell: {
      description: mode === "write"
        ? "Run one controlled git command in the workspace shell. Supports read-only git commands plus local fetch, checkout, and switch on a clean working tree."
        : "Run one controlled read-only git command in the workspace shell.",
      execute: (input: unknown) => run(input, mode === "write"),
      inputSchema: gitShellInputSchema(mode === "write"
        ? "Git shell command, for example `git status --short`, `git diff --stat`, `git log --oneline -n 20`, `git fetch origin pull/123/head`, or `git switch main`. Bare git subcommands are accepted and normalized to start with `git`. Pass one command only; do not use shell composition such as `&&` or `|`."
        : "Read-only git shell command, for example `git status --short`, `git diff --stat`, or `git log --oneline -n 20`. Bare git subcommands are accepted and normalized to start with `git`. Pass one command only; do not use shell composition such as `&&` or `|`."),
      name: "shell",
      policy: mode === "write" && options.policy ? gitShellPolicy(options.policy, defaultCwd) : undefined,
    },
  }
}

function gitShellInputSchema(commandDescription: string): JSONSchema7 {
  return {
    additionalProperties: false,
    properties: {
      command: { description: commandDescription, type: "string" },
      cwd: { description: "Workspace-relative directory. Defaults to the pull request checkout when available, otherwise the workspace root.", type: "string" },
    },
    required: ["command"],
    type: "object",
  }
}

export function git(options: GitCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Git")
  const maxOutputLength = options.maxOutputLength ?? defaultMaxOutputLength
  const timeout = options.timeout ?? defaultTimeout
  const sessionStates = new WeakMap<object, GitSessionState>()

  function sessionState(context: object): GitSessionState {
    let state = sessionStates.get(context)
    if (!state) {
      state = {}
      sessionStates.set(context, state)
    }
    return state
  }

  function getSessionResolver(context: { context?: { get(key: string): unknown }, workspace?: unknown }): (cwd: string) => Promise<GitSessionHandle> {
    return async (cwd) => {
      const workspace = context.workspace
      if (!isGitSessionWorkspace(workspace)) {
        throw new Error("[vitehub] git() requires a git-capable workspace session.")
      }
      const state = sessionState(context)
      const workspacePath = gitSessionWorkspacePath(cwd, context)
      const key = workspacePath || ""
      state.sessionPromises ??= new Map()
      if (!state.sessionPromises.has(key)) {
        state.sessionPromises.set(key, workspace.startSession(workspacePath ? { paths: [workspacePath] } : undefined).then(async (session) => {
          try {
            const prepared = await preparePullRequestGitSession(session, workspacePath, context, timeout)
            return { commitWrites: !prepared, session }
          }
          catch (error) {
            try {
              await session.close()
            }
            catch {}
            throw error
          }
        }).catch((error) => {
          state.sessionPromises?.delete(key)
          throw error
        }))
      }
      const handle = await state.sessionPromises.get(key)
      if (!handle) {
        throw new Error("[vitehub] git() requires a git-capable workspace session.")
      }
      return handle
    }
  }

  async function closeSession(context: object): Promise<void> {
    const state = sessionStates.get(context)
    sessionStates.delete(context)
    const sessions = await Promise.all([...state?.sessionPromises?.values() || []])
    if (state) state.sessionPromises = undefined
    await Promise.all(sessions.map(({ session }) => session.close()))
  }

  return defineCapability({
    id: "git",
    mode,
    metadata: { mode },
    requires: [{ primitive: "workspace", workspace: { mode: "write", required: true } }],
    tools: context => gitTools(mode, {
      maxOutputLength,
      policy: options.policy,
      timeout,
    }, getSessionResolver(context), defaultGitCwd(context)),
    close: closeSession,
  })
}
