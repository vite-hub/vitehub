export function getAgentInvocationRecoveryWorkflowName(agentWorkflowName: string): string {
  return `vitehub-agent-invocation-recovery-${agentWorkflowName}`
}
