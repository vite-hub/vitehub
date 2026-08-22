import type { AgentInvocationRecord, AgentInvocationSummary } from 'vite-hub/agent'

export type Invocation = AgentInvocationRecord | AgentInvocationSummary
export function invocationTitle(invocation: Invocation) {
  return invocation.agentName || 'Agent Invocation'
}

export function invocationSummary(invocation: Invocation) {
  if (invocation.error?.message) return invocation.error.message
  if (invocation.origin) return invocation.origin
  if (invocation.channelId) return `Channel ${invocation.channelId}`
  if (invocation.threadId) return `Thread ${invocation.threadId}`
  return invocation.id
}
