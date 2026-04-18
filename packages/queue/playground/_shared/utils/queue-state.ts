export type QueueStateJob = {
  attempts: number
  id: string
  payload: unknown
}

type QueueStateGlobal = typeof globalThis & {
  __vitehubQueueJobs?: QueueStateJob[]
}

function getStore() {
  const target = globalThis as QueueStateGlobal
  target.__vitehubQueueJobs ||= []
  return target.__vitehubQueueJobs
}

export function getQueueState() {
  return [...getStore()]
}

export function pushQueueJob(job: QueueStateJob) {
  getStore().push(job)
}

export function resetQueueState() {
  getStore().length = 0
}
