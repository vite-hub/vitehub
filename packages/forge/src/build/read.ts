import { readBuildRevision, readGit } from "@vite-hub/internal/build/revision"

import type { ForgeBuild } from "./identity.ts"

/** `owner/name` of a GitHub or Enterprise remote. The forge's API URL selects the server at runtime. */
export function githubRepository(remote: string | undefined): string | undefined {
  return remote ? /^(?:(?:https?|ssh|git):\/\/[^/]+\/|(?:[^@/:]+@)?[\w.-]+:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1] : undefined
}

/** The pull request that the CI or host builds, when it names one. */
function pullRequestOf(env: Record<string, string | undefined>): number | undefined {
  const value = env.VERCEL_GIT_PULL_REQUEST_ID
    || (env.PULL_REQUEST === "true" ? env.REVIEW_ID : undefined)
    || /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1]
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/**
 * The build of the app, from the CI or host, else from Git: the commit and branch, the GitHub repository, and the pull
 * request when the host names it. `VITEHUB_BUILD_COMMIT` and `VITEHUB_BUILD_REPOSITORY` win over the rest, for builds
 * that have neither CI variables nor `.git`, such as a Docker build. Empty outside a Git checkout.
 */
export async function readForgeBuild(root: string, env: Record<string, string | undefined> = process.env): Promise<ForgeBuild> {
  const repository = env.VITEHUB_BUILD_REPOSITORY
    || env.GITHUB_REPOSITORY
    || (env.VERCEL_GIT_PROVIDER === "github" && env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : undefined)
    || githubRepository(env.REPOSITORY_URL)
    || githubRepository(await readGit(root, ["remote", "get-url", "origin"]))
  const pullRequest = pullRequestOf(env)
  return { ...await readBuildRevision(root, env), ...(repository ? { repository } : {}), ...(pullRequest ? { pullRequest } : {}) }
}
