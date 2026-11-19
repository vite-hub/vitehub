import { readFile } from "node:fs/promises"

import { readBuildRepository, readBuildRevision, readGit, type BuildGit } from "@vite-hub/internal/build/revision"

import type { ConsoleProjectBuild } from "./runtime/server/project.ts"

type Env = Record<string, string | undefined>

/**
 * The CI variables that give the subject and the author of the commit, so a checkout without history still has them.
 * `login` counts only when the `provider` variable says `github`, because it names a login on that Git provider.
 */
const commitDetails: ReadonlyArray<{ sha: string, message: string, author?: string, login?: { name: string, provider: string } }> = [
  { sha: "VERCEL_GIT_COMMIT_SHA", message: "VERCEL_GIT_COMMIT_MESSAGE", author: "VERCEL_GIT_COMMIT_AUTHOR_NAME", login: { name: "VERCEL_GIT_COMMIT_AUTHOR_LOGIN", provider: "VERCEL_GIT_PROVIDER" } },
  { sha: "CI_COMMIT_SHA", message: "CI_COMMIT_TITLE" },
]

const shaPattern = /^[0-9a-f]{7,64}$/i
/** A GitHub login. A bot account, such as `dependabot[bot]`, has no avatar at `github.com/<login>.png`, so it does not match. */
const loginPattern = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i
/** The GitHub address that hides an author's email: `<id>+<login>@users.noreply.github.com`, or `<login>@…` for old accounts. */
const noreplyPattern = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i

function login(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && loginPattern.test(trimmed) ? trimmed : undefined
}

/** The GitHub login of the author of `sha` in the payload of a GitHub Actions `push` event. */
async function pushEventLogin(env: Env, sha: string): Promise<string | undefined> {
  if (env.GITHUB_EVENT_NAME !== "push" || !env.GITHUB_EVENT_PATH) return undefined
  try {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as { head_commit?: { id?: unknown, author?: { username?: unknown } } }
    const username = event.head_commit?.author?.username
    return String(event.head_commit?.id).toLowerCase() === sha && String(username) === username ? login(username) : undefined
  }
  catch {
    return undefined
  }
}

function text(value: string | undefined, max: number): string | undefined {
  const line = value?.split("\n", 1)[0]?.trim()
  if (!line) return undefined
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * What a production build records about its source: the build time, the Git commit, and its github.com repository.
 * The commit and branch come from the same place as the health route's commit: the CI or host, else `git`. The
 * author's GitHub login comes from Vercel, the GitHub Actions `push` event, or a GitHub noreply email in `git`. A build
 * without Git records only the time. `SOURCE_DATE_EPOCH` sets the time of a reproducible build.
 */
export async function collectConsoleBuild(options: { cwd: string, env?: Env, git?: BuildGit, now?: () => Date }): Promise<ConsoleProjectBuild> {
  const env = options.env ?? process.env
  const git = options.git ?? (args => readGit(options.cwd, args))
  const epoch = Number(env.SOURCE_DATE_EPOCH)
  const time = (env.SOURCE_DATE_EPOCH && Number.isInteger(epoch) ? new Date(epoch * 1000) : (options.now ?? (() => new Date()))()).toISOString()

  const revision = await readBuildRevision(options.cwd, env, git)
  const sha = revision.commit?.trim().toLowerCase()
  if (!sha || !shaPattern.test(sha)) return { time }
  const details = commitDetails.find(variables => env[variables.sha]?.trim().toLowerCase() === sha)
  let message = details ? text(env[details.message], 200) : undefined
  let author = details?.author ? text(env[details.author], 100) : undefined
  let authorLogin = details?.login
    ? env[details.login.provider] === "github" ? login(env[details.login.name]) : undefined
    : await pushEventLogin(env, sha)
  if (!message || !author || !authorLogin) {
    // `%x00` separates the fields, because a subject or a name may hold any other character.
    const [head, subject, name, email] = (await git(["log", "-1", "--format=%H%x00%s%x00%an%x00%ae", sha]) ?? "").split("\0")
    // A CI checkout may not have the commit of the variable, so the answer counts only when the SHAs match.
    if (head?.toLowerCase() === sha) {
      message ??= text(subject, 200)
      author ??= text(name, 100)
      authorLogin ??= login(noreplyPattern.exec(email?.trim() ?? "")?.[1])
    }
  }
  const branch = text(revision.branch, 200)
  const repository = await readBuildRepository(options.cwd, env, git)
  return {
    time,
    commit: { sha, ...(message ? { message } : {}), ...(author ? { author } : {}), ...(authorLogin ? { login: authorLogin } : {}), ...(branch ? { branch } : {}), ...(repository ? { repository } : {}) },
  }
}

const collected = new Map<string, Promise<ConsoleProjectBuild>>()

/** The build facts of a project, collected once per process, so each write of the generated plugin names the same build. */
export function consoleBuildOf(projectRoot: string): Promise<ConsoleProjectBuild> {
  let build = collected.get(projectRoot)
  if (!build) collected.set(projectRoot, build = collectConsoleBuild({ cwd: projectRoot }))
  return build
}
