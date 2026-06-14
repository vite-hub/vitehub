import { joinURL, withQuery } from "ufo"
import { CIMalformedResponseError } from "../errors.ts"
import { createCIHTTPClient } from "../http.ts"
import {
  normalizeGithubConclusion,
  normalizeGithubStatus,
  normalizeKnownTrigger,
} from "../normalize.ts"
import type { CIContext, CIProvider, CIRun } from "../types.ts"

interface GithubRun {
  id?: number
  name?: string
  head_branch?: string
  head_sha?: string
  event?: string
  status?: string
  conclusion?: string | null
  html_url?: string
  created_at?: string
  run_started_at?: string
  updated_at?: string
  actor?: { login?: string }
  triggering_actor?: { login?: string }
  repository?: { full_name?: string, html_url?: string }
  head_commit?: {
    message?: string
    author?: { name?: string, email?: string }
  }
}

interface GithubRunsResponse {
  workflow_runs?: GithubRun[]
}

interface GithubRepository {
  full_name?: string
  archived?: boolean
  disabled?: boolean
}

interface GithubJob {
  id?: number
  name?: string
  conclusion?: string | null
}

interface GithubJobsResponse {
  jobs?: GithubJob[]
}

export const githubCIProvider: CIProvider = {
  id: "github",
  name: "GitHub Actions",

  async listRuns(context, query) {
    const client = createGithubClient(context)
    const repositories = await resolveGithubRepositories(client, context)
    const pages = await Promise.all(repositories.map(async ({ owner, repo }) => {
      const path = withQuery(joinURL("/repos", owner, repo, "actions", "runs"), {
        branch: query?.branch,
        head_sha: query?.commitSha,
        per_page: query?.limit,
      })
      const response = await client<GithubRunsResponse>(path)
      return response.workflow_runs ?? []
    }))
    return pages
      .flat()
      .map(normalizeGithubRun)
      .sort(compareRunsNewestFirst)
      .slice(0, query?.limit)
  },

  async getRun(context, runID) {
    assertRepoContext(context)
    const client = createGithubClient(context)
    const path = joinURL("/repos", context.owner!, context.repo!, "actions", "runs", runID)
    return normalizeGithubRun(await client<GithubRun>(path))
  },

  async getLogs(context, runID, query) {
    assertRepoContext(context)
    const client = createGithubClient(context)
    if (query?.jobID) {
      return {
        lines: parseGithubLogText(await fetchGithubJobLog(client, context, query.jobID)),
      }
    }

    const jobs = await listGithubJobs(client, context, runID)
    const orderedJobs = [
      ...jobs.filter((job) => normalizeGithubConclusion(job.conclusion) === "failed"),
      ...jobs.filter((job) => normalizeGithubConclusion(job.conclusion) !== "failed"),
    ]
    const selectedJobs = typeof query?.limit === "number" ? orderedJobs.slice(0, query.limit) : orderedJobs
    const pages = await Promise.all(selectedJobs.map(async (job) => ({
      job,
      text: job.id ? await fetchGithubJobLog(client, context, String(job.id)) : "",
    })))

    return {
      lines: pages.flatMap(({ job, text }) => [
        { message: `## ${job.name ?? `Job ${job.id ?? "unknown"}`}`, stream: "system" as const },
        ...parseGithubLogText(text),
      ]),
      raw: { jobs },
    }
  },
}

function createGithubClient(context: CIContext) {
  return createCIHTTPClient("github", "https://api.github.com", context.token, {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  })
}

function assertRepoContext(context: CIContext) {
  if (!context.owner || !context.repo) {
    throw new CIMalformedResponseError("GitHub CI context requires owner and repo.", { provider: "github" })
  }
}

async function resolveGithubRepositories(
  client: ReturnType<typeof createGithubClient>,
  context: CIContext,
): Promise<Array<{ owner: string, repo: string }>> {
  if (context.owner && context.repo) {
    return [{ owner: context.owner, repo: context.repo }]
  }

  const path = context.owner
    ? withQuery(joinURL("/users", context.owner, "repos"), { per_page: 100, sort: "pushed", type: "all" })
    : withQuery("/user/repos", { per_page: 100, sort: "pushed", visibility: "all", affiliation: "owner,collaborator,organization_member" })
  const repositories = await client<GithubRepository[]>(path)

  return repositories
    .filter((repository) => !repository.archived && !repository.disabled)
    .map((repository) => repository.full_name?.split("/") ?? [])
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]))
    .map(([owner, repo]) => ({ owner, repo }))
}

function normalizeGithubRun(run: GithubRun): CIRun {
  if (typeof run.id !== "number") {
    throw new CIMalformedResponseError("GitHub workflow run is missing id.", { provider: "github" })
  }

  return {
    id: String(run.id),
    provider: "github",
    projectID: run.repository?.full_name ?? "",
    projectName: run.name,
    branch: run.head_branch,
    commitSha: run.head_sha,
    commitMessage: run.head_commit?.message,
    authorName: run.head_commit?.author?.name,
    authorUsername: run.triggering_actor?.login ?? run.actor?.login,
    trigger: normalizeKnownTrigger(run.event),
    status: normalizeGithubStatus(run.status),
    outcome: normalizeGithubConclusion(run.conclusion),
    createdAt: run.created_at,
    startedAt: run.run_started_at,
    finishedAt: run.updated_at,
    webUrl: run.html_url,
    sourceUrl: run.repository?.html_url && run.head_sha ? `${run.repository.html_url}/commit/${run.head_sha}` : undefined,
    raw: run,
  }
}

async function listGithubJobs(client: ReturnType<typeof createGithubClient>, context: CIContext, runID: string): Promise<GithubJob[]> {
  const path = joinURL("/repos", context.owner!, context.repo!, "actions", "runs", runID, "jobs")
  const response = await client<GithubJobsResponse>(path)
  return response.jobs ?? []
}

async function fetchGithubJobLog(client: ReturnType<typeof createGithubClient>, context: CIContext, jobID: string): Promise<string> {
  const path = joinURL("/repos", context.owner!, context.repo!, "actions", "jobs", jobID, "logs")
  return await client<string>(path, { responseType: "text" })
}

function parseGithubLogText(text: string) {
  return text.split(/\r?\n/).filter(Boolean).map((message) => ({ message, stream: "unknown" as const }))
}

function compareRunsNewestFirst(a: CIRun, b: CIRun): number {
  return Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "")
}
