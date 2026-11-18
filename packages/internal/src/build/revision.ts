import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

/** The commit and branch that a build comes from. */
export interface BuildRevision {
  branch?: string
  commit?: string
}

/** Runs `git` with `args` and answers its trimmed output, or `undefined` when Git fails or prints nothing. */
export type BuildGit = (args: string[]) => Promise<string | undefined>

/** CI and host variables that name the commit and branch of a build, in the order they are read. */
const buildVariables: ReadonlyArray<readonly [commit: string, branch: string]> = [
  ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF"],
  ["WORKERS_CI_COMMIT_SHA", "WORKERS_CI_BRANCH"],
  ["CF_PAGES_COMMIT_SHA", "CF_PAGES_BRANCH"],
  ["COMMIT_REF", "BRANCH"],
  ["GITHUB_SHA", "GITHUB_HEAD_REF"],
  ["CI_COMMIT_SHA", "CI_COMMIT_REF_NAME"],
  ["RENDER_GIT_COMMIT", "RENDER_GIT_BRANCH"],
]

/** The trimmed output of a Git command in `root`, or `undefined` when Git fails or prints nothing. */
export async function readGit(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", args, { cwd: root, encoding: "utf8", timeout: 3000 })
    return stdout.trim() || undefined
  }
  catch {
    return undefined
  }
}

/**
 * On a GitHub Actions `pull_request` event, `GITHUB_SHA` is the test merge commit, which matches no deployment of the
 * pull request. The event payload names the head commit.
 */
async function pullRequestHead(env: Record<string, string | undefined>): Promise<string | undefined> {
  if (!env.GITHUB_EVENT_NAME?.startsWith("pull_request") || !env.GITHUB_EVENT_PATH) return undefined
  try {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { head?: { sha?: unknown } } }
    const sha = event.pull_request?.head?.sha
    return typeof sha === "string" && sha ? sha : undefined
  }
  catch {
    return undefined
  }
}

/** The commit and branch that the CI or host names, else Git's. Empty outside a Git checkout. */
async function discoveredRevision(env: Record<string, string | undefined>, git: BuildGit): Promise<BuildRevision> {
  for (const [commitName, branchName] of buildVariables) {
    const commit = commitName === "GITHUB_SHA" ? await pullRequestHead(env) ?? env.GITHUB_SHA : env[commitName]
    if (!commit) continue
    const branch = env[branchName] || (commitName === "GITHUB_SHA" ? env.GITHUB_REF_NAME : undefined)
    return { commit, ...(branch ? { branch } : {}) }
  }
  const [commit, branch] = await Promise.all([git(["rev-parse", "HEAD"]), git(["rev-parse", "--abbrev-ref", "HEAD"])])
  // A detached checkout, as many CI hosts make, answers `HEAD` for the branch.
  return { ...(commit ? { commit } : {}), ...(branch && branch !== "HEAD" ? { branch } : {}) }
}

/**
 * The commit and branch of the build, from the CI or host, else from Git. `VITEHUB_BUILD_COMMIT` and
 * `VITEHUB_BUILD_BRANCH` each replace their own field. Empty outside a Git checkout.
 */
export async function readBuildRevision(root: string, env: Record<string, string | undefined> = process.env, git: BuildGit = args => readGit(root, args)): Promise<BuildRevision> {
  const { VITEHUB_BUILD_COMMIT: commit, VITEHUB_BUILD_BRANCH: branch } = env
  const found = commit && branch ? {} : await discoveredRevision(env, git)
  return { ...found, ...(commit ? { commit } : {}), ...(branch ? { branch } : {}) }
}

/** `owner/name` of a remote on github.com. Credentials in the remote are never part of the answer. */
function githubComRepository(remote: string | undefined): string | undefined {
  return remote ? /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1] : undefined
}

/**
 * The github.com repository of the build, as `owner/name`, from the CI or host, else from the `origin` remote.
 * `VITEHUB_BUILD_REPOSITORY` wins over the rest. A repository on another forge, or on GitHub Enterprise, has none.
 */
export async function readBuildRepository(root: string, env: Record<string, string | undefined> = process.env, git: BuildGit = args => readGit(root, args)): Promise<string | undefined> {
  const explicit = env.VITEHUB_BUILD_REPOSITORY?.trim()
  if (explicit) return explicit
  if (env.GITHUB_REPOSITORY && (!env.GITHUB_SERVER_URL || env.GITHUB_SERVER_URL === "https://github.com")) return env.GITHUB_REPOSITORY
  if (env.VERCEL_GIT_PROVIDER === "github" && env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG) return `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}`
  return githubComRepository(env.REPOSITORY_URL) ?? githubComRepository(await git(["remote", "get-url", "origin"]))
}
