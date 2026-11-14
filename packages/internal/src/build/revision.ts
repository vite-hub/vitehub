import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

/** The commit and branch that a build comes from. */
export interface BuildRevision {
  branch?: string
  commit?: string
}

/** CI and host variables that name the commit and branch of a build, in the order they are read. */
const buildVariables: ReadonlyArray<readonly [commit: string, branch: string]> = [
  ["VITEHUB_BUILD_COMMIT", "VITEHUB_BUILD_BRANCH"],
  ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF"],
  ["WORKERS_CI_COMMIT_SHA", "WORKERS_CI_BRANCH"],
  ["CF_PAGES_COMMIT_SHA", "CF_PAGES_BRANCH"],
  ["COMMIT_REF", "BRANCH"],
  ["GITHUB_SHA", "GITHUB_HEAD_REF"],
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

/** The commit and branch of the build, from the CI or host, else from Git. Empty outside a Git checkout. */
export async function readBuildRevision(root: string, env: Record<string, string | undefined> = process.env): Promise<BuildRevision> {
  for (const [commitName, branchName] of buildVariables) {
    const commit = commitName === "GITHUB_SHA" ? await pullRequestHead(env) ?? env.GITHUB_SHA : env[commitName]
    if (!commit) continue
    const branch = env[branchName] || (commitName === "GITHUB_SHA" ? env.GITHUB_REF_NAME : undefined)
    return { commit, ...(branch ? { branch } : {}) }
  }
  const [commit, branch] = await Promise.all([readGit(root, ["rev-parse", "HEAD"]), readGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])])
  return { ...(commit ? { commit } : {}), ...(branch && branch !== "HEAD" ? { branch } : {}) }
}
