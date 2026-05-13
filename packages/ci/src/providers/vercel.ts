import { joinURL, withQuery } from "ufo"
import { CIMalformedResponseError } from "../errors.ts"
import { createCIHTTPClient } from "../http.ts"
import {
  epochOrStringToISOString,
  firstString,
  normalizeKnownTrigger,
  normalizeVercelOutcome,
  normalizeVercelStatus,
} from "../normalize.ts"
import type { CIContext, CILogPage, CILogQuery, CIProvider, CIRun, CIRunQuery } from "../types.ts"

interface VercelDeployment {
  uid?: string
  id?: string
  name?: string
  url?: string
  inspectorUrl?: string
  state?: string
  readyState?: string
  createdAt?: number
  buildingAt?: number
  ready?: number
  meta?: Record<string, unknown>
  creator?: { username?: string, email?: string, name?: string }
  project?: { id?: string, name?: string }
  projectId?: string
  target?: string
}

interface VercelListDeploymentsResponse {
  deployments?: VercelDeployment[]
}

interface VercelEvent {
  created?: number
  date?: number
  payload?: { text?: string, deploymentId?: string, info?: { type?: string } }
  text?: string
  type?: string
  level?: string
  serial?: string
}

export const vercelCIProvider: CIProvider = {
  id: "vercel",
  name: "Vercel Deployments",

  async listRuns(context, query) {
    const client = createVercelClient(context)
    const path = withQuery("/v6/deployments", {
      app: query?.projectName,
      projectId: query?.projectID,
      limit: query?.limit,
      teamId: context.teamID,
      "meta-githubCommitSha": query?.commitSha,
      "meta-githubCommitRef": query?.branch,
    })
    const response = await client<VercelListDeploymentsResponse>(path)
    return (response.deployments ?? []).map(normalizeVercelDeployment)
  },

  async getRun(context, runID) {
    const client = createVercelClient(context)
    const path = withQuery(joinURL("/v13/deployments", runID), { teamId: context.teamID })
    return normalizeVercelDeployment(await client<VercelDeployment>(path))
  },

  async getLogs(context, runID, query) {
    const client = createVercelClient(context)
    const path = withQuery(joinURL("/v3/deployments", runID, "events"), {
      builds: 1,
      direction: "forward",
      limit: query?.limit ?? 100,
      teamId: context.teamID,
    })
    const response = await client<VercelEvent[] | { events?: VercelEvent[] }>(path)
    const events = Array.isArray(response) ? response : response.events ?? []
    return {
      lines: events.map((event) => ({
        timestamp: epochOrStringToISOString(event.created ?? event.date),
        message: String(event.payload?.text ?? event.text ?? event.serial ?? ""),
        stream: normalizeVercelEventStream(event),
      })),
      raw: response,
    }
  },
}

export function createVercelCIProvider(): CIProvider {
  return vercelCIProvider
}

function createVercelClient(context: CIContext) {
  return createCIHTTPClient("vercel", "https://api.vercel.com", context.token)
}

function normalizeVercelDeployment(deployment: VercelDeployment): CIRun {
  const id = firstString(deployment.uid, deployment.id)
  if (!id) {
    throw new CIMalformedResponseError("Vercel deployment is missing uid/id.", { provider: "vercel" })
  }

  const state = deployment.readyState ?? deployment.state
  const meta = deployment.meta ?? {}
  const commitSha = firstString(meta.githubCommitSha, meta.gitCommitSha, meta.commitSha)
  const repoOwner = firstString(meta.githubOrg, meta.githubRepoOwner, meta.gitRepoOwner)
  const repoName = firstString(meta.githubRepo, meta.githubRepoName, meta.gitRepoName)

  return {
    id,
    provider: "vercel",
    projectID: deployment.project?.id ?? deployment.projectId ?? deployment.name ?? "",
    projectName: deployment.project?.name ?? deployment.name,
    branch: firstString(meta.githubCommitRef, meta.gitCommitRef, meta.branch),
    commitSha,
    commitMessage: firstString(meta.githubCommitMessage, meta.gitCommitMessage),
    authorName: firstString(meta.githubCommitAuthorName, deployment.creator?.name, deployment.creator?.email),
    authorUsername: firstString(meta.githubCommitAuthorLogin, deployment.creator?.username),
    trigger: normalizeKnownTrigger(firstString(meta.githubDeployment, deployment.target)),
    status: normalizeVercelStatus(state),
    outcome: normalizeVercelOutcome(state),
    createdAt: epochOrStringToISOString(deployment.createdAt),
    startedAt: epochOrStringToISOString(deployment.buildingAt),
    finishedAt: epochOrStringToISOString(deployment.ready),
    webUrl: deployment.inspectorUrl ?? (deployment.url ? `https://${deployment.url}` : undefined),
    sourceUrl: repoOwner && repoName && commitSha ? `https://github.com/${repoOwner}/${repoName}/commit/${commitSha}` : undefined,
    raw: deployment,
  }
}

function normalizeVercelEventStream(event: VercelEvent): "stdout" | "stderr" | "system" | "unknown" {
  const level = String(event.level ?? event.payload?.info?.type ?? event.type ?? "").toLowerCase()
  if (level.includes("error")) return "stderr"
  if (level.includes("stdout")) return "stdout"
  if (level.includes("stderr")) return "stderr"
  if (level.length > 0) return "system"
  return "unknown"
}
