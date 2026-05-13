export type CIProviderID = "vercel" | "cloudflare" | "github"

export type CIRunStatus =
  | "queued"
  | "initializing"
  | "running"
  | "completed"
  | "unknown"

export type CIRunOutcome =
  | "success"
  | "failed"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "unknown"

export type CITrigger =
  | "push"
  | "pull_request"
  | "manual"
  | "api"
  | "schedule"
  | "unknown"

export interface CIContext {
  token: string
  accountID?: string
  teamID?: string
  owner?: string
  repo?: string
}

export interface CIRunQuery {
  projectID?: string
  projectName?: string
  branch?: string
  commitSha?: string
  limit?: number
}

export interface CILogQuery {
  jobID?: string
  cursor?: string
  limit?: number
}

export interface CIRun {
  id: string
  provider: CIProviderID
  projectID: string
  projectName?: string
  jobID?: string
  jobName?: string
  branch?: string
  commitSha?: string
  commitMessage?: string
  authorName?: string
  authorUsername?: string
  trigger: CITrigger
  status: CIRunStatus
  outcome?: CIRunOutcome
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  webUrl?: string
  sourceUrl?: string
  raw?: unknown
}

export interface CILogLine {
  timestamp?: string
  message: string
  stream?: "stdout" | "stderr" | "system" | "unknown"
}

export interface CILogPage {
  lines: CILogLine[]
  cursor?: string
  truncated?: boolean
  raw?: unknown
}

export interface CIProvider {
  readonly id: CIProviderID
  readonly name: string

  listRuns(context: CIContext, query?: CIRunQuery): Promise<CIRun[]>
  getRun(context: CIContext, runID: string): Promise<CIRun>
  getLogs(context: CIContext, runID: string, query?: CILogQuery): Promise<CILogPage>
}
