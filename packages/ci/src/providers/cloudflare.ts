import { joinURL, withQuery } from "ufo"
import { CIMalformedResponseError } from "../errors.ts"
import { createCIHTTPClient } from "../http.ts"
import {
  epochOrStringToISOString,
  firstString,
  normalizeCloudflareOutcome,
  normalizeCloudflareStatus,
  normalizeKnownTrigger,
} from "../normalize.ts"
import type { CIContext, CILogPage, CILogQuery, CIProvider, CIRun, CIRunQuery } from "../types.ts"

interface CloudflareEnvelope<T> {
  success?: boolean
  result?: T
  errors?: Array<{ message?: string }>
}

interface CloudflareBuild {
  build_uuid?: string
  uuid?: string
  external_script_id?: string
  build_status?: string
  build_outcome?: string | null
  created_on?: string
  running_on?: string
  stopped_on?: string
  build_trigger_metadata?: CloudflareTriggerMetadata
}

interface CloudflareTriggerMetadata {
  branch?: string
  commit_hash?: string
  commit_message?: string
  author?: string
  build_trigger_source?: string
  provider_account_name?: string
  provider_type?: string
  repo_name?: string
}

interface CloudflareListResult {
  builds?: CloudflareBuild[] | Record<string, CloudflareBuild>
}

interface CloudflareLogResult {
  lines?: Array<[unknown, unknown]>
  cursor?: string
  truncated?: boolean
}

export const cloudflareCIProvider: CIProvider = {
  id: "cloudflare",
  name: "Cloudflare Workers Builds",

  async listRuns(context, query) {
    assertAccountID(context)
    const client = createCloudflareClient(context)
    const projectID = requiredProjectID(query)

    const path = withQuery(
      joinURL("/accounts", context.accountID!, "builds", "builds", "latest"),
      { external_script_ids: projectID },
    )
    const envelope = await client<CloudflareEnvelope<CloudflareListResult>>(path)
    const builds = readCloudflareBuilds(envelope, "cloudflare")
    return builds.map(normalizeCloudflareBuild).slice(0, query?.limit)
  },

  async getRun(context, runID) {
    assertAccountID(context)
    const client = createCloudflareClient(context)
    const path = joinURL("/accounts", context.accountID!, "builds", "builds", runID)
    const envelope = await client<CloudflareEnvelope<CloudflareBuild>>(path)
    if (!envelope.result) {
      throw new CIMalformedResponseError("Cloudflare build response did not include a result.", { provider: "cloudflare" })
    }
    return normalizeCloudflareBuild(envelope.result)
  },

  async getLogs(context, runID, query) {
    assertAccountID(context)
    const client = createCloudflareClient(context)
    const basePath = joinURL("/accounts", context.accountID!, "builds", "builds", runID, "logs")
    const path = query?.cursor ? withQuery(basePath, { cursor: query.cursor }) : basePath
    const envelope = await client<CloudflareEnvelope<CloudflareLogResult>>(path)
    if (!envelope.result) {
      throw new CIMalformedResponseError("Cloudflare logs response did not include a result.", { provider: "cloudflare" })
    }
    return normalizeCloudflareLogs(envelope.result, query)
  },
}

export function createCloudflareCIProvider(): CIProvider {
  return cloudflareCIProvider
}

function createCloudflareClient(context: CIContext) {
  return createCIHTTPClient("cloudflare", "https://api.cloudflare.com/client/v4", context.token)
}

function assertAccountID(context: CIContext) {
  if (!context.accountID) {
    throw new CIMalformedResponseError("Cloudflare CI context requires accountID.", { provider: "cloudflare" })
  }
}

function requiredProjectID(query?: CIRunQuery): string {
  if (!query?.projectID) {
    throw new CIMalformedResponseError("Cloudflare listRuns requires query.projectID as the Worker external_script_id.", { provider: "cloudflare" })
  }
  return query.projectID
}

function readCloudflareBuilds(envelope: CloudflareEnvelope<CloudflareListResult>, provider: string): CloudflareBuild[] {
  const builds = envelope.result?.builds
  if (Array.isArray(builds)) return builds
  if (builds && typeof builds === "object") return Object.values(builds)
  throw new CIMalformedResponseError("Cloudflare builds response did not include builds.", { provider })
}

function normalizeCloudflareBuild(build: CloudflareBuild): CIRun {
  const metadata = build.build_trigger_metadata
  const id = firstString(build.build_uuid, build.uuid)
  if (!id) {
    throw new CIMalformedResponseError("Cloudflare build is missing build_uuid.", { provider: "cloudflare" })
  }

  const repo = metadata?.provider_account_name && metadata.repo_name
    ? `${metadata.provider_account_name}/${metadata.repo_name}`
    : undefined

  return {
    id,
    provider: "cloudflare",
    projectID: build.external_script_id ?? "",
    projectName: build.external_script_id,
    branch: metadata?.branch,
    commitSha: metadata?.commit_hash,
    commitMessage: metadata?.commit_message,
    authorName: metadata?.author,
    authorUsername: metadata?.provider_account_name,
    trigger: normalizeKnownTrigger(metadata?.build_trigger_source),
    status: normalizeCloudflareStatus(build.build_status),
    outcome: normalizeCloudflareOutcome(build.build_outcome),
    createdAt: build.created_on,
    startedAt: build.running_on,
    finishedAt: build.stopped_on,
    sourceUrl: repo && metadata?.commit_hash ? `https://github.com/${repo}/commit/${metadata.commit_hash}` : undefined,
    raw: build,
  }
}

function normalizeCloudflareLogs(result: CloudflareLogResult, query?: CILogQuery): CILogPage {
  const lines = Array.isArray(result.lines) ? result.lines : []
  return {
    lines: lines.slice(0, query?.limit).map(([timestamp, message]) => ({
      timestamp: epochOrStringToISOString(timestamp),
      message: String(message ?? ""),
      stream: "unknown",
    })),
    cursor: result.cursor,
    truncated: result.truncated,
    raw: result,
  }
}

