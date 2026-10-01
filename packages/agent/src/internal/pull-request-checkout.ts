import type { WorkspaceSession } from "@vite-hub/workspace"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import type { AgentGitHub } from "../types.ts"
import { isRuntimeObject, isRuntimeString } from "./runtime-value.ts"

export interface PullRequestCheckoutPlan {
  baseRef?: string
  /** Local branch that tracks the pull request head branch. */
  headBranch?: string
  /** Head repository when it differs from the base repository. */
  headRepository?: string
  headRef: string
  headSha: string
  mount: string
  repository: string
}

type ContextStore = { get(key: string): unknown } | undefined

const githubRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const gitRefPattern = /^[A-Za-z0-9._/-]+$/
const gitEnv = {
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  PAGER: "cat",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRuntimeObject(value) && value !== null && !Array.isArray(value)
}

function safeRepository(repo: unknown): string | undefined {
  return isRuntimeString(repo) && githubRepositoryPattern.test(repo) ? repo : undefined
}

export function safeGitRef(ref: unknown): string | undefined {
  if (!isRuntimeString(ref) || !ref || ref.length > 250) return
  if (!gitRefPattern.test(ref) || ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith(".lock") || ref.endsWith("/") || ref.startsWith("/") || ref.startsWith("-")) return
  return ref
}

function safeGitSha(sha: unknown): string | undefined {
  if (!isRuntimeString(sha)) return
  const normalized = sha.toLowerCase()
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized) ? normalized : undefined
}

/** Normalize a Workspace-relative mount. Returns undefined for paths that leave the Workspace. */
export function safeWorkspaceMount(path: unknown, allowRoot = false): string | undefined {
  if (!isRuntimeString(path)) return
  const stripped = path.replace(/\\/g, "/").replace(/^\/workspace(?:\/|$)/, "")
  const parts = stripped.split("/").filter(Boolean)
  if (parts.some(part => part === "." || part === "..")) return
  const mount = parts.join("/")
  if (!mount && !allowRoot) return
  return mount
}

function remoteRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "")
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Read the GitHub pull request checkout that the github() Channel requested for this invocation. */
export function pullRequestCheckoutPlan(context: ContextStore): PullRequestCheckoutPlan | undefined {
  const raw = context?.get("pullRequest")
  const pullRequest = isRecord(raw) && isRecord(raw.pullRequest) ? raw.pullRequest : isRecord(raw) ? raw : undefined
  if (!pullRequest) return

  const provider = isRecord(raw) ? raw.provider : undefined
  if (isRuntimeString(provider) && provider !== "github") return

  const source = isRecord(pullRequest.source) ? pullRequest.source : undefined
  if (source?.checkout === false) return
  const base = isRecord(pullRequest.base) ? pullRequest.base : undefined
  const head = isRecord(pullRequest.head) ? pullRequest.head : undefined
  const repositoryRecord = isRecord(raw) && isRecord(raw.repository) ? raw.repository : undefined
  const repository = safeRepository(source?.repo)
    || safeRepository(isRecord(raw) ? raw.repository : undefined)
    || safeRepository(repositoryRecord?.fullName)
  const mount = source && "mount" in source
    ? safeWorkspaceMount(source.mount, true)
    : safeWorkspaceMount(repositoryRecord?.name)
  const headRef = safeGitRef(source?.ref) || safeGitRef(head?.ref) || safeGitRef(pullRequest.headRef)
  const baseRef = safeGitRef(base?.ref) || safeGitRef(pullRequest.baseRef)
  if (!repository || mount === undefined || !headRef) return
  const headSha = safeGitSha(head?.sha) || safeGitSha(pullRequest.headSha)
  if (!headSha) throw agentDiagnostics.AGENT_R0069({ message: "[vitehub] GitHub pull request checkout requires an exact head SHA." })
  const headBranchRef = safeGitRef(head?.ref)
  const headBranch = headBranchRef && !headBranchRef.startsWith("refs/") ? headBranchRef : undefined
  const headRepository = safeRepository(head?.repo)
  if (headBranch && !headRepository) {
    throw agentDiagnostics.AGENT_R0069({ message: "[vitehub] GitHub pull request checkout requires an explicit head repository to track the head branch." })
  }

  const plan: PullRequestCheckoutPlan = { headRef: remoteRef(headRef), headSha, mount, repository }
  if (baseRef) plan.baseRef = remoteRef(baseRef)
  if (headBranch) plan.headBranch = headBranch
  if (headRepository && headRepository.toLowerCase() !== repository.toLowerCase()) plan.headRepository = headRepository
  return plan
}

/** Resolve base access and add environment-only credentials for a fork push remote. */
export async function pullRequestCheckoutEnvironment(
  github: AgentGitHub | undefined,
  repository: string | undefined,
  abortSignal?: AbortSignal,
  headRepository?: string,
): Promise<Record<string, string>> {
  if (!github) return {}
  const input: { repository?: string, signal?: AbortSignal } = {}
  if (repository) input.repository = repository
  if (abortSignal) input.signal = abortSignal
  const base = await github.access(input)
  if (!headRepository || headRepository.toLowerCase() === repository?.toLowerCase()) return base.env

  const head = await github.access({ ...input, repository: headRepository })
  const env: Record<string, string> = { ...base.env, VITEHUB_GITHUB_HEAD_TOKEN: head.token }
  let count = Number(env.GIT_CONFIG_COUNT || 0)
  const config = (key: string, value: string) => {
    env[`GIT_CONFIG_KEY_${count}`] = key
    env[`GIT_CONFIG_VALUE_${count}`] = value
    count++
  }
  config("credential.https://github.com.useHttpPath", "true")
  for (const suffix of ["", ".git"]) {
    const key = `credential.https://github.com/${headRepository}${suffix}.helper`
    config(key, "")
    config(key, '!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "$VITEHUB_GITHUB_HEAD_TOKEN"; fi; }; f')
  }
  env.GIT_CONFIG_COUNT = String(count)
  return env
}

/**
 * Turn the pull request mount into a real Git checkout of the exact head SHA.
 * The checkout has `origin`, the fetched base branch, and a local branch that tracks the head branch.
 * Credentials come only from `env`; nothing is written to the repository configuration.
 * Returns false when the mount already holds a checkout of the expected head.
 */
export async function preparePullRequestCheckout(
  session: Pick<WorkspaceSession, "exec">,
  plan: PullRequestCheckoutPlan,
  options: { abortSignal?: AbortSignal, env?: Record<string, string>, timeout?: number } = {},
): Promise<boolean> {
  const cwd = plan.mount ? `/workspace/${plan.mount}` : "/workspace"
  const execOptions = { abortSignal: options.abortSignal, cwd, env: gitEnv, timeout: options.timeout }
  const existing = await session.exec("git", ["rev-parse", "--is-inside-work-tree"], execOptions)
  if (existing.exitCode === 0) {
    const head = await session.exec("git", ["rev-parse", "HEAD"], execOptions)
    if (head.exitCode !== 0 || head.stdout.trim().toLowerCase() !== plan.headSha) {
      throw agentDiagnostics.AGENT_R0070({ message: "[vitehub] existing pull request checkout does not match the expected SHA." })
    }
    return false
  }

  const baseTrackingRef = plan.baseRef ? `refs/remotes/origin/${branchName(plan.baseRef)}` : undefined
  const fetchRefspecs = [
    `${plan.headRef}:refs/vitehub/head`,
    ...(plan.baseRef && baseTrackingRef ? [`${plan.baseRef}:${baseTrackingRef}`] : []),
  ].map(shellQuote).join(" ")
  const headRemote = plan.headRepository ? "head" : "origin"
  const script = [
    "set -eu",
    ...(plan.mount
      ? [
          `rm -rf -- ${shellQuote(plan.mount)}`,
          `mkdir -p -- ${shellQuote(plan.mount)}`,
          `cd -- ${shellQuote(plan.mount)}`,
        ]
      : ["cd -- ."]),
    "git init -q",
    `git remote add origin ${shellQuote(`https://github.com/${plan.repository}.git`)}`,
    ...(plan.headRepository ? [`git remote add head ${shellQuote(`https://github.com/${plan.headRepository}.git`)}`] : []),
    `git fetch --no-tags --depth=100 origin ${fetchRefspecs}`,
    `test "$(git rev-parse refs/vitehub/head)" = ${shellQuote(plan.headSha)} || { echo "[vitehub] fetched pull request head does not match the expected SHA." >&2; exit 1; }`,
    plan.mount ? "git checkout -q --detach refs/vitehub/head" : "git reset -q --hard refs/vitehub/head",
    ...(baseTrackingRef ? [`git branch -f vitehub-base ${shellQuote(baseTrackingRef)} >/dev/null`] : []),
    "git branch -f vitehub-head HEAD >/dev/null",
    ...(plan.headBranch
      ? [
          `git checkout -q -B ${shellQuote(plan.headBranch)}`,
          `git config ${shellQuote(`branch.${plan.headBranch}.remote`)} ${headRemote}`,
          `git config ${shellQuote(`branch.${plan.headBranch}.merge`)} ${shellQuote(`refs/heads/${plan.headBranch}`)}`,
        ]
      : []),
  ].join("\n")
  const result = await session.exec("sh", ["-c", script], {
    abortSignal: options.abortSignal,
    cwd: "/workspace",
    env: { ...gitEnv, ...options.env },
    timeout: options.timeout,
  })
  if (result.exitCode !== 0) {
    throw agentDiagnostics.AGENT_R0071({ message: result.stderr || result.stdout || "[vitehub] git could not prepare pull request checkout." })
  }
  return true
}
