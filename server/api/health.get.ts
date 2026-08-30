import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { useServerEnv } from '#vitehub/env/server'
import { defineEventHandler } from 'h3'
import { createAgentInspectionMetadata } from 'vite-hub/agent'
import { summarizeAgentInvocationWorkload } from 'vite-hub/agent/server'
import babysitterAgent from '../agents/babysitter/agent.ts'
import { babysitterWorkload } from '../babysitter.schedule.ts'
import { resolveMaxOwners, resolveRepositories } from '../babysitter.queue.ts'
import { consoleClient } from '../console.ts'
import { github } from '../github.ts'
import { invocations } from '../invocations.ts'

const exec = promisify(execFile)

type DiagnosticStatus = 'neutral' | 'ok' | 'warning'
type Diagnostic = { detail?: string, label: string, status: DiagnosticStatus, value: string }

export default defineEventHandler(async () => {
  const checkedAt = new Date().toISOString()
  const { maxOwners, repositories: configuredRepositories, repository } = useServerEnv().babysitter
  const repositories = resolveRepositories(configuredRepositories, repository)
  const ownerLimit = resolveMaxOwners(maxOwners)
  const capacity = createAgentInspectionMetadata(babysitterAgent).config?.driver.capacity
  const githubBudget = github.budget()
  const processStartedAt = Date.now() - process.uptime() * 1_000
  const [githubDiagnostic, codex, invocationState] = await Promise.all([
    checkGitHub(),
    checkCodex(),
    invocations.list({ limit: 100 })
      .then(recent => ({ counts: summarizeAgentInvocationWorkload(recent.invocations, processStartedAt) }))
      .catch(() => ({ counts: undefined })),
  ])
  const counts = invocationState.counts ?? { active: 0, completed: 0, failed: 0, stale: 0, total: 0 }
  const healthy = githubDiagnostic.status === 'ok' && codex.status === 'ok' && invocationState.counts !== undefined && counts.stale === 0
  const diagnostics: Diagnostic[] = [
    githubDiagnostic,
    {
      label: 'GitHub budget',
      status: githubBudget.limited ? 'warning' : 'ok',
      value: githubBudget.limited ? 'Work queued' : 'Available',
      detail: githubBudget.limited
        ? `${githubBudget.remaining} GraphQL points · resumes ${new Date(githubBudget.resetAt).toISOString()}`
        : 'GraphQL admission reserve available',
    },
    codex,
    { label: 'Model', status: 'ok', value: 'gpt-5.6-sol', detail: 'High reasoning effort' },
    { label: 'Agent', status: 'ok', value: 'babysitter', detail: 'Pull-request convergence' },
    { label: 'Runtime', status: 'ok', value: `Node ${process.version}`, detail: formatUptime(process.uptime()) },
    { label: 'Repositories', status: 'ok', value: `${repositories.length} configured`, detail: repositories.join(', ') },
    {
      label: 'Admission',
      status: capacity?.reason?.startsWith('sample-error:') ? 'warning' : 'ok',
      value: `Adaptive · ${capacity?.active ?? 0} active · ${capacity?.effectiveConcurrency ?? ownerLimit} admitted`,
      detail: `${capacity?.pending ?? 0} queued · hard max ${ownerLimit}${capacity?.reason ? ` · ${capacity.reason}` : ''}`,
    },
    { label: 'Work discovery', status: 'ok', value: 'On demand', detail: 'Startup, owner completion, and 30s repair scan' },
    {
      label: 'Invocation state',
      status: invocationState.counts === undefined || counts.stale ? 'warning' : 'ok',
      value: invocationState.counts === undefined ? 'Unavailable' : counts.stale ? `${counts.stale} stale` : 'Reconciled',
      detail: invocationState.counts === undefined
        ? 'Invocation records could not be read'
        : counts.stale ? 'Active records predate this service process' : 'No active record predates this service process',
    },
    { label: 'Console delivery', status: consoleClient ? 'ok' : 'neutral', value: consoleClient ? 'Connected' : 'Optional · not configured' },
  ]

  return {
    checkedAt,
    diagnostics,
    status: healthy ? 'healthy' : 'degraded',
    summary: healthy ? 'Babysitter is operational' : 'Babysitter needs attention',
    workload: { ...counts, ...babysitterWorkload(), queued: capacity?.pending ?? 0 },
  }
})

async function checkGitHub(): Promise<Diagnostic> {
  try {
    await github.access({ fallback: true })
    return { label: 'GitHub', status: 'ok', value: 'Connected', detail: 'Credentials available' }
  }
  catch {
    return { label: 'GitHub', status: 'warning', value: 'Not connected', detail: 'Pull-request work is blocked' }
  }
}

async function checkCodex(): Promise<Diagnostic> {
  try {
    const { stdout } = await exec('codex', ['--version'], { timeout: 2_000 })
    const version = stdout.trim().split(/\r?\n/, 1)[0] || 'Available'
    return { label: 'Codex', status: 'ok', value: version, detail: 'Provider executable available' }
  }
  catch {
    return { label: 'Codex', status: 'warning', value: 'Not available', detail: 'Agent invocation is blocked' }
  }
}

function formatUptime(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Up for ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `Up for ${hours}h ${minutes % 60}m`
}
