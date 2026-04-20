export type QueueStateItem = {
  attempts: number
  id: string
  payload: unknown
}

const queueStateUrl = "https://vitehub-queue.internal/jobs"

function getMemoryStore() {
  const target = globalThis as { __vitehubQueueJobs?: QueueStateItem[] }
  target.__vitehubQueueJobs ||= []
  return target.__vitehubQueueJobs
}

function getCacheStorage() {
  return typeof caches !== "undefined" ? caches.default : undefined
}

export async function readQueueState(): Promise<QueueStateItem[]> {
  const cache = getCacheStorage()
  if (!cache) {
    return [...getMemoryStore()]
  }

  const response = await cache.match(queueStateUrl)
  if (!response) {
    return []
  }

  try {
    const parsed = await response.json<QueueStateItem[]>()
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function resetQueueState(): Promise<void> {
  const cache = getCacheStorage()
  if (!cache) {
    getMemoryStore().length = 0
    return
  }

  await cache.delete(queueStateUrl)
}

export async function appendQueueState(item: QueueStateItem): Promise<void> {
  const cache = getCacheStorage()
  if (!cache) {
    getMemoryStore().push(item)
    return
  }

  const jobs = await readQueueState()
  jobs.push(item)
  await cache.put(queueStateUrl, new Response(JSON.stringify(jobs), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  }))
}
