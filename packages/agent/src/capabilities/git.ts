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

export type GitCapabilityToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface GitCapabilityOptions {
  maxOutputLength?: number
  mode?: AgentCapabilityMode
  policy?: GitCapabilityToolPolicy
  timeout?: number
}

interface GitCommandInput {
  command: string
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
  sessionPromise?: Promise<WorkspaceSession>
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
const defaultMaxOutputLength = 30_000
const gitEnv = {
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  PAGER: "cat",
}

type GitSessionWorkspace = {
  startSession: () => Promise<WorkspaceSession>
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
  if (words[1].startsWith("-")) throw new Error("[vitehub] git() does not accept global git flags. Use the tool cwd option instead of `git -C`.")
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
      throw new Error(`[vitehub] git ${subcommand} option ${option} is not available through git_read.`)
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
      throw new Error(`[vitehub] git ${args[0]} option ${option} is not available through git_write.`)
    }
    assertWorkspaceArg(arg)
  }
}

function assertGitFetch(args: string[]): void {
  for (const arg of args.slice(1)) {
    const option = optionName(arg)
    if (blockedFetchOptions.has(option) || blockedFetchOptions.has(arg.slice(0, 2))) {
      throw new Error(`[vitehub] git fetch option ${option} is not available through git_write.`)
    }
  }
  const [, ...refspecs] = fetchPositionals(args)
  for (const refspec of refspecs) {
    assertWorkspaceArg(refspec)
    if (refspec.startsWith("+") || refspec.includes(":")) {
      throw new Error("[vitehub] git fetch cannot update local ref destinations through git_write.")
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

function gitTools(
  mode: AgentCapabilityMode,
  options: Required<Pick<GitCapabilityOptions, "maxOutputLength">> & Pick<GitCapabilityOptions, "policy" | "timeout">,
  getSession: () => Promise<WorkspaceSession>,
): AgentToolSet {
  async function run(input: GitCommandInput, write: boolean): Promise<GitCommandResult> {
    if (typeof input?.command !== "string" || !input.command.trim()) {
      throw new Error("[vitehub] git command must be a non-empty string.")
    }
    const args = parseGitCommand(input.command)
    write ? assertGitWrite(args) : assertGitRead(args)
    const cwd = normalizeCwd(input.cwd)
    const session = await getSession()
    if (write && args[0] === "fetch") await assertConfiguredFetchRemote(session, cwd, options.timeout, args)
    if (write && writeSubcommands.has(args[0]!)) await cleanWorkingTree(session, cwd, options.timeout)
    const result = await session.exec("git", args, gitExecOptions(cwd, options.timeout))
    if (write && writeSubcommands.has(args[0]!) && result.exitCode === 0) {
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

  const tools: AgentToolSet = {
    git_read: {
      description: "Run one read-only git command in the workspace.",
      execute: (input: unknown) => run(input as GitCommandInput, false),
      inputSchema: gitInputSchema("Read-only git command, for example `git status --short`, `git diff --stat`, or `git log --oneline -n 20`."),
      name: "git_read",
    },
  }

  if (mode === "write") {
    tools.git_write = {
      description: "Run one local git write command in the workspace. Supports fetch, checkout, and switch on a clean working tree.",
      execute: (input: unknown) => run(input as GitCommandInput, true),
      inputSchema: gitInputSchema("Local git command, for example `git fetch origin pull/123/head` or `git switch main`."),
      name: "git_write",
      policy: options.policy || "require-approval",
    }
  }

  return tools
}

function gitInputSchema(commandDescription: string) {
  return {
    additionalProperties: false,
    properties: {
      command: { description: commandDescription, type: "string" },
      cwd: { description: "Workspace-relative directory. Defaults to the workspace root.", type: "string" },
    },
    required: ["command"],
    type: "object",
  }
}

export function git(options: GitCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Git")
  const maxOutputLength = options.maxOutputLength ?? defaultMaxOutputLength
  const sessionStates = new WeakMap<object, GitSessionState>()

  function sessionState(context: object): GitSessionState {
    let state = sessionStates.get(context)
    if (!state) {
      state = {}
      sessionStates.set(context, state)
    }
    return state
  }

  function getSessionResolver(context: { workspace?: unknown }): () => Promise<WorkspaceSession> {
    return async () => {
      const workspace = context.workspace
      if (!isGitSessionWorkspace(workspace)) {
        throw new Error("[vitehub] git() requires a git-capable workspace session.")
      }
      const state = sessionState(context)
      state.sessionPromise ??= workspace.startSession().catch((error) => {
        state.sessionPromise = undefined
        throw error
      })
      return await state.sessionPromise
    }
  }

  async function closeSession(context: object): Promise<void> {
    const state = sessionStates.get(context)
    sessionStates.delete(context)
    const session = await state?.sessionPromise
    if (state) state.sessionPromise = undefined
    await session?.close()
  }

  return defineCapability({
    id: "git",
    mode,
    metadata: { mode },
    requires: [{ primitive: "workspace", workspace: { mode: "write", required: true } }],
    tools: context => gitTools(mode, {
      maxOutputLength,
      policy: options.policy,
      timeout: options.timeout,
    }, getSessionResolver(context)),
    close: closeSession,
  })
}
