import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import type {
  MemoryQueueClient,
  MemoryQueueProviderOptions,
  MemoryQueueStore,
  MemoryQueueStoreItem,
  QueueSendResult,
} from "../types.ts"

function createStore(store?: MemoryQueueStore): MemoryQueueStore {
  return store || { messages: [] }
}

export function createMemoryQueueClient(provider: MemoryQueueProviderOptions = { provider: "memory" }): MemoryQueueClient {
  const store = createStore(provider.store)

  return {
    provider: "memory",
    native: store,
    async send(input) {
      const normalized = normalizeQueueEnqueueInput(input)
      const item: MemoryQueueStoreItem = {
        enqueuedAt: new Date(),
        messageId: normalized.id,
        payload: normalized.payload,
      }
      store.messages.push(item)
      return { status: "queued", messageId: item.messageId }
    },
    async sendBatch(items) {
      const results: QueueSendResult[] = []
      for (const item of items) {
        results.push(await this.send({
          id: item.id,
          payload: item.payload,
        }))
      }
      return results
    },
    size: () => store.messages.length,
    peek: (limit = 10) => store.messages.slice(0, Math.max(0, limit)),
    async drain(handler) {
      let count = 0
      while (store.messages.length) {
        const item = store.messages.shift()!
        await handler(item.payload, {
          enqueuedAt: item.enqueuedAt,
          messageId: item.messageId,
        })
        count += 1
      }
      return count
    },
  }
}
