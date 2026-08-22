import type { AgentInvocationView } from '@vite-hub/ui'
import type { AgentInvocationRecord, AgentInvocationSummary } from 'vite-hub/agent'

export type Invocation = AgentInvocationRecord | AgentInvocationSummary | AgentInvocationView
export function invocationTitle(invocation: Invocation) {
  const githubTitle = invocation.annotations?.['github.title']
  return (typeof githubTitle === 'string' ? githubTitle : undefined) || invocation.agentName || 'Agent Invocation'
}

export function invocationContext(invocation: Invocation) {
  const repository = invocation.annotations?.['github.repository']
  const pullRequest = invocation.annotations?.['github.pullRequest']
  if (typeof repository === 'string' && (typeof pullRequest === 'string' || typeof pullRequest === 'number')) {
    return `${repository} · PR #${pullRequest}`
  }
  return invocation.threadId || invocation.origin || invocation.id
}

export function invocationProject(invocation: Invocation) {
  const repository = invocation.annotations?.['github.repository']
  if (typeof repository === 'string') return repository.split('/').at(-1) || repository
  return invocation.agentName || 'Workspace'
}

export function invocationSummary(invocation: Invocation) {
  if (invocation.error?.message) return invocation.error.message
  if (invocation.origin) return invocation.origin
  if ('channelId' in invocation && invocation.channelId) return `Channel ${invocation.channelId}`
  if (invocation.threadId) return `Thread ${invocation.threadId}`
  return invocation.id
}
