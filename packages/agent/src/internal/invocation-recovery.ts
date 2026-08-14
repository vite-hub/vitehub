import type { AgentRuntimeContext } from "../types.ts"

const invocationRecoveryTasksByMemo = new WeakMap<AgentRuntimeContext["memo"], Array<Promise<void>>>()

export function agentInvocationRecoveryTasks(context: AgentRuntimeContext): Array<Promise<void>> {
  let tasks = invocationRecoveryTasksByMemo.get(context.memo)
  if (!tasks) {
    tasks = []
    invocationRecoveryTasksByMemo.set(context.memo, tasks)
  }
  return tasks
}

export function registerAgentInvocationRecovery(context: AgentRuntimeContext, promise: Promise<unknown>): void {
  const task = Promise.resolve(promise).then(() => {}, () => {})
  agentInvocationRecoveryTasks(context).push(task)
  context.waitUntil(task)
}
