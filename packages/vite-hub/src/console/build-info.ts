import { execFileSync } from "node:child_process"

import type { ConsoleProjectBuild } from "./runtime/server/project.ts"

type Env = Record<string, string | undefined>

/**
 * The commit variables of each CI host, in order. Vercel also gives the message and the author. GitHub Actions sets
 * `GITHUB_HEAD_REF` only for pull requests, so `GITHUB_REF_NAME` is the branch of other events.
 */
const commitVariables: ReadonlyArray<{ sha: string, branch: readonly string[], message?: string, author?: string }> = [
  { sha: "VERCEL_GIT_COMMIT_SHA", branch: ["VERCEL_GIT_COMMIT_REF"], message: "VERCEL_GIT_COMMIT_MESSAGE", author: "VERCEL_GIT_COMMIT_AUTHOR_NAME" },
  { sha: "WORKERS_CI_COMMIT_SHA", branch: ["WORKERS_CI_BRANCH"] },
  { sha: "CF_PAGES_COMMIT_SHA", branch: ["CF_PAGES_BRANCH"] },
  { sha: "GITHUB_SHA", branch: ["GITHUB_HEAD_REF", "GITHUB_REF_NAME"] },
  { sha: "CI_COMMIT_SHA", branch: ["CI_COMMIT_REF_NAME"], message: "CI_COMMIT_TITLE" },
  { sha: "COMMIT_REF", branch: ["BRANCH"] },
  { sha: "RENDER_GIT_COMMIT", branch: ["RENDER_GIT_BRANCH"] },
]

const shaPattern = /^[0-9a-f]{7,64}$/i

function text(value: string | undefined, max: number): string | undefined {
  const line = value?.split("\n", 1)[0]?.trim()
  if (!line) return undefined
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Run `git` in the project. Any failure, such as a build without Git or outside a repository, gives `undefined`. */
function runGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000, windowsHide: true })
  }
  catch {
    return undefined
  }
}

/**
 * What a production build records about its source: the build time and the Git commit. CI variables come first, and
 * `git` in the project fills what they leave out. A build without Git records only the time. `SOURCE_DATE_EPOCH` sets
 * the time of a reproducible build.
 */
export function collectConsoleBuild(options: { cwd: string, env?: Env, git?: (args: readonly string[]) => string | undefined, now?: () => Date }): ConsoleProjectBuild {
  const env = options.env ?? process.env
  const git = options.git ?? (args => runGit(options.cwd, args))
  const epoch = Number(env.SOURCE_DATE_EPOCH)
  const time = (env.SOURCE_DATE_EPOCH && Number.isInteger(epoch) ? new Date(epoch * 1000) : (options.now ?? (() => new Date()))()).toISOString()

  const source = commitVariables.find(variables => shaPattern.test(env[variables.sha]?.trim() ?? ""))
  let sha = source && env[source.sha]?.trim().toLowerCase()
  let message = source?.message ? text(env[source.message], 200) : undefined
  let author = source?.author ? text(env[source.author], 100) : undefined
  let branch = text(source?.branch.map(name => env[name]).find(Boolean), 200)

  if (!message || !author) {
    // `%x00` separates the fields, because a subject or a name may hold any other character.
    const [head, subject, name] = (git(["log", "-1", "--format=%H%x00%s%x00%an", sha ?? "HEAD"]) ?? "").trim().split("\0")
    // A CI checkout may not have the commit of the variable, so the answer counts only when the SHAs match.
    if (head && shaPattern.test(head) && (!sha || head.toLowerCase() === sha)) {
      sha = head.toLowerCase()
      message ??= text(subject, 200)
      author ??= text(name, 100)
    }
  }
  if (sha && !branch) {
    const ref = git(["rev-parse", "--abbrev-ref", "HEAD"])?.trim()
    // A detached checkout, as many CI hosts make, answers `HEAD`.
    if (ref && ref !== "HEAD") branch = text(ref, 200)
  }
  if (!sha) return { time }
  return { time, commit: { sha, ...(message ? { message } : {}), ...(author ? { author } : {}), ...(branch ? { branch } : {}) } }
}

const collected = new Map<string, ConsoleProjectBuild>()

/** The build facts of a project, collected once per process, so each write of the generated plugin names the same build. */
export function consoleBuildOf(projectRoot: string): ConsoleProjectBuild {
  let build = collected.get(projectRoot)
  if (!build) collected.set(projectRoot, build = collectConsoleBuild({ cwd: projectRoot }))
  return build
}
