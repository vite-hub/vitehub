import { afterEach, expect, it, vi } from 'vitest'
import { defineAgent } from '../src/index.ts'
import { createAgentHealth } from '../src/server/health.ts'
import type { AgentHealthOptions } from '../src/server/health.ts'

const agent = defineAgent({ name: 'support', driver: { kind: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', capacity: { concurrency: 4 } } })
const processHealth: NonNullable<AgentHealthOptions['process']> = {
  health: async () => ({ checkedAt: new Date().toISOString(), status: 'healthy', diagnostics: [{ label: 'Runtime', status: 'ok', value: 'Node' }], workload: { active: 0, completed: 1, failed: 0, stale: 0, total: 1 } }),
}
afterEach(() => vi.useRealTimers())

it('derives model and capacity while preserving project workload and informational waits', async () => {
  const health = createAgentHealth({ name: 'Support', agent: () => agent, process: processHealth,
    console: () => true, workload: () => ({ running: 2 }),
    diagnostics: () => [{ label: 'GitHub budget', status: 'warning', value: 'Waiting', affectsHealth: false }],
  })
  const report = await health()
  expect(report).toMatchObject({ status: 'healthy', summary: 'Support is operational', workload: { completed: 1, running: 2, queued: 0 } })
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ label: 'Model', value: 'gpt-6-astra', detail: 'medium reasoning effort' }))
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ label: 'Admission', value: '0 active · 4 admitted' }))
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ label: 'Console delivery', value: 'Connected' }))
})

it('degrades failed checks and does not leak dependency errors', async () => {
  const health = createAgentHealth({ name: 'Support', agent: () => agent, process: processHealth,
    diagnostics: () => [{ label: 'Dependency', status: 'warning', value: 'Unavailable' }],
  })
  expect((await health()).status).toBe('degraded')
  const failing = createAgentHealth({ name: 'Support', agent: () => { throw new Error('secret-token') } })
  const report = await failing()
  expect(report.status).toBe('degraded')
  expect(JSON.stringify(report)).not.toContain('secret-token')
})

it('uses the definition provider status without resolving or invoking the agent', async () => {
  const status = vi.fn(async () => ({ agent: 'support', checkedAt: new Date().toISOString(), readiness: 'ready' as const, stale: false }))
  const resolve = vi.fn(agent.resolve)
  const health = createAgentHealth({ name: 'Support', agent: () => ({ ...agent, status, resolve }) })
  expect((await health()).status).toBe('healthy')
  expect(status).toHaveBeenCalledOnce()
  expect(resolve).not.toHaveBeenCalled()
})

it('coalesces polling, times out, and waits for ignored cancellation before retrying', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const diagnostics = vi.fn(async () => { await wait; return [] })
  const health = createAgentHealth({ name: 'Support', agent: () => agent, process: processHealth, diagnostics, timeoutMs: 50, maxAgeMs: 10 })
  const first = health()
  expect(health()).toBe(first)
  await vi.advanceTimersByTimeAsync(50)
  expect(await first).toMatchObject({ status: 'degraded', diagnostics: [{ value: 'Timed out' }] })
  await vi.advanceTimersByTimeAsync(100)
  expect(health()).toBe(first)
  expect(diagnostics).toHaveBeenCalledOnce()
  release()
  await vi.advanceTimersByTimeAsync(1)
  expect((await health()).status).toBe('healthy')
  expect(diagnostics).toHaveBeenCalledTimes(2)
  await health()
  expect(diagnostics).toHaveBeenCalledTimes(2)
})

it('reports GitHub budget waits without exposing credentials or treating them as failures', async () => {
  const access = vi.fn(async () => ({ token: 'private-token', env: { GH_TOKEN: 'private-token' } }))
  const github = { access, budget: () => ({ limited: true as const, remaining: 80, resetAt: Date.now() + 60_000 }) }
  const health = createAgentHealth({ name: 'Support', agent: () => agent, process: processHealth, github, maxAgeMs: 0 })
  const report = await health()
  expect(report.status).toBe('healthy')
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ label: 'GitHub budget', status: 'warning', value: 'Work queued' }))
  expect(JSON.stringify(report)).not.toContain('private-token')
  access.mockRejectedValueOnce(new Error('private-token'))
  expect((await health()).status).toBe('degraded')
})
