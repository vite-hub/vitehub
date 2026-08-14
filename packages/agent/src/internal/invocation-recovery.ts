import type { AgentRuntimeContext } from "../types.ts"

const invocationRecoveryTasksByMemo = new WeakMap<AgentRuntimeContext["memo"], Array<Promise<void>>>()

export function agentInvocationRecoveryTasks(context: AgentRuntimeContext): Array<Promise<void>> {
  return invocationRecoveryTasksByMemo.get(context.memo) || []
}

function ensureAgentInvocationRecoveryTasks(context: AgentRuntimeContext): Array<Promise<void>> {
  let tasks = invocationRecoveryTasksByMemo.get(context.memo)
  if (!tasks) {
    tasks = []
    invocationRecoveryTasksByMemo.set(context.memo, tasks)
  }
  return tasks
}

export function registerAgentInvocationRecovery(context: AgentRuntimeContext, promise: Promise<unknown>): void {
  const task = Promise.resolve(promise).then(() => {}, () => {})
  const tasks = ensureAgentInvocationRecoveryTasks(context)
  tasks.push(task)
  void task.then(() => {
    const index = tasks.indexOf(task)
    if (index !== -1) tasks.splice(index, 1)
    if (tasks.length === 0) invocationRecoveryTasksByMemo.delete(context.memo)
  })
  context.waitUntil(task)
}
