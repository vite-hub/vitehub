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
  const send: MemoryQueueClient["send"] = async (input) => {
    const normalized = normalizeQueueEnqueueInput(input)
    const item: MemoryQueueStoreItem = {
      enqueuedAt: new Date(),
      messageId: normalized.id,
      payload: normalized.payload,
    }
    store.messages.push(item)
    return { status: "queued", messageId: item.messageId }
  }

  return {
    provider: "memory",
    native: store,
    send,
    async sendBatch(items) {
      const results: QueueSendResult[] = []
      for (const item of items) {
        results.push(await send({
          id: item.id,
          payload: item.payload,
        }))
      }
      return results
    },
    size: () => store.messages.length,
    peek: (limit = 10) => store.messages.slice(0, Math.max(0, limit)),
    consume(messageId) {
      const index = store.messages.findIndex(item => item.messageId === messageId)
      if (index === -1) return
      return store.messages.splice(index, 1)[0]
    },
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
