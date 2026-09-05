import type { AgentInput } from '../types.ts'
import type { GitHubHost } from './github-host.ts'
import { createAgentInspectionMetadata } from '../workspace-agent.ts'
import { createAgentStatusReader } from './provider-status.ts'
import { readAgentInvocationWorkload } from './invocation-health.ts'

export interface AgentHealthDiagnostic {
  label: string
  status: 'neutral' | 'ok' | 'warning'
  value: string
  detail?: string
  /** Informational waits, such as a GitHub budget reset, need not degrade health. */
  affectsHealth?: boolean
}

export interface AgentHealthReport {
  checkedAt: string
  diagnostics: AgentHealthDiagnostic[]
  status: 'healthy' | 'degraded'
  summary: string
  workload: Record<string, number>
}

export interface AgentHealthOptions {
  name: string
  agent: () => AgentInput | Promise<AgentInput>
  process?: { health(): Promise<Pick<AgentHealthReport, 'checkedAt' | 'diagnostics' | 'status' | 'workload'>> }
  github?: Pick<GitHubHost, 'access' | 'budget'>
  console?: () => boolean
  diagnostics?: (signal: AbortSignal) => readonly AgentHealthDiagnostic[] | Promise<readonly AgentHealthDiagnostic[]>
  workload?: () => Record<string, number> | Promise<Record<string, number>>
  maxAgeMs?: number
  timeoutMs?: number
}

/** Inspect operational health without creating an invocation or sending a model prompt. */
export function createAgentHealth(options: AgentHealthOptions): () => Promise<AgentHealthReport> {
  const readStatus = createAgentStatusReader({ timeoutMs: options.timeoutMs })
  let cached: AgentHealthReport | undefined
  let expiresAt = 0
  let pending: Promise<AgentHealthReport> | undefined

  async function sample(signal: AbortSignal): Promise<AgentHealthReport> {
    const agent = await options.agent()
    signal.throwIfAborted()
    const driver = createAgentInspectionMetadata(agent).config?.driver
    const base = await options.process?.health()
    const diagnostics: AgentHealthDiagnostic[] = base ? [...base.diagnostics] : []
    const workload = base?.workload ?? (agent.invocations ? await readAgentInvocationWorkload(agent.invocations, 0) : {})
    if (!base) {
      diagnostics.push({ label: 'Runtime', status: 'ok', value: globalThis.process?.version ? `Node ${globalThis.process.version}` : 'Server runtime' })
      const status = await readStatus(agent, agent.name ?? options.name)
      diagnostics.push({
        label: 'Provider',
        status: status.readiness === 'ready' && !status.stale ? 'ok' : status.readiness === 'unsupported' ? 'neutral' : 'warning',
        value: status.readiness === 'ready' && !status.stale ? 'Ready' : status.stale ? 'Status unavailable' : status.readiness,
        detail: status.checkedAt ? `Checked ${status.checkedAt}` : undefined,
      })
    }
    diagnostics.push({ label: 'Agent', status: 'ok', value: agent.name ?? options.name })
    const model = driver?.provider?.model ?? driver?.model?.id
    if (model) diagnostics.push({ label: 'Model', status: 'ok', value: model, detail: driver?.provider?.reasoningEffort ? `${driver.provider.reasoningEffort} reasoning effort` : undefined })
    const capacity = driver?.capacity
    if (capacity) diagnostics.push({
      label: 'Admission', status: capacity.reason?.startsWith('sample-error:') ? 'warning' : 'ok',
      value: `${capacity.active} active · ${capacity.effectiveConcurrency ?? capacity.concurrency} admitted`,
      detail: `${capacity.pending} queued · hard max ${capacity.concurrency}${capacity.reason ? ` · ${capacity.reason}` : ''}`,
    })
    signal.throwIfAborted()
    if (options.github) {
      try {
        await options.github.access({ fallback: true, signal })
        diagnostics.push({ label: 'GitHub', status: 'ok', value: 'Connected', detail: 'Credentials available' })
      } catch {
        diagnostics.push({ label: 'GitHub', status: 'warning', value: 'Not connected', detail: 'Pull-request work is blocked' })
      }
      const budget = options.github.budget()
      diagnostics.push({
        label: 'GitHub budget', status: budget.limited ? 'warning' : 'ok', affectsHealth: false,
        value: budget.limited ? 'Work queued' : 'Available',
        detail: budget.limited ? `${budget.remaining} GraphQL points · resumes ${new Date(budget.resetAt).toISOString()}` : 'GraphQL admission reserve available',
      })
    }
    if (options.console) {
      const connected = options.console()
      diagnostics.push({ label: 'Console delivery', status: connected ? 'ok' : 'neutral', value: connected ? 'Connected' : 'Optional · not configured' })
    }
    if (options.diagnostics) diagnostics.push(...await options.diagnostics(signal))
    const healthy = base?.status !== 'degraded' && !diagnostics.some(item => item.status === 'warning' && item.affectsHealth !== false)
    const counts: Record<string, number> = { ...workload, ...await options.workload?.() }
    if (capacity) counts.queued = capacity.pending
    return {
      checkedAt: new Date().toISOString(), diagnostics,
      status: healthy ? 'healthy' : 'degraded',
      summary: `${options.name} ${healthy ? 'is operational' : 'needs attention'}`,
      workload: counts,
    }
  }

  return () => {
    if (pending) return pending
    if (cached && expiresAt > Date.now()) return Promise.resolve(cached)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Health inspection timed out.'))
        reject(controller.signal.reason)
      }, options.timeoutMs ?? 15_000)
    })
    const probe = sample(controller.signal)
    pending = Promise.race([probe, timeout]).catch((): AgentHealthReport => ({
      checkedAt: new Date().toISOString(),
      diagnostics: [{ label: 'Health inspection', status: 'warning', value: controller.signal.aborted ? 'Timed out' : 'Unavailable' }],
      status: 'degraded', summary: `${options.name} needs attention`, workload: {},
    })).then(report => {
      cached = report
      expiresAt = Date.now() + (options.maxAgeMs ?? 5_000)
      return report
    }).finally(() => {
      clearTimeout(timer)
      // Keep one sample in flight even when a dependency ignores cancellation.
      void probe.finally(() => { pending = undefined }).catch(() => undefined)
    })
    return pending
  }
}
