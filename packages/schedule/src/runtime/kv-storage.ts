export interface ScheduleKVStorage {
  del(key: string): boolean | Promise<boolean> | Promise<void> | void
  get<T = unknown>(key: string): Promise<T | null | undefined> | T | null | undefined
  has(key: string): boolean | Promise<boolean>
  keys(base?: string): Promise<string[]> | string[]
  set<T = unknown>(key: string, value: T): Promise<void> | void
}

interface ViteHubKVStorage {
  del(key: string): Promise<readonly [unknown, unknown]>
  get<T = unknown>(key: string): Promise<readonly [unknown, T | null | undefined]>
  has(key: string): Promise<readonly [unknown, boolean | undefined]>
  keys(base?: string): Promise<readonly [unknown, string[] | undefined]>
  set<T = unknown>(key: string, value: T): Promise<readonly [unknown, unknown]>
}

export function createScheduleKVStorage(kvStore: ViteHubKVStorage): ScheduleKVStorage {
  return {
    async del(key) {
      const [error] = await kvStore.del(key)
      if (error) throw error
    },
    async get<T = unknown>(key: string) {
      const [error, value] = await kvStore.get<T>(key)
      if (error) throw error
      return value
    },
    async has(key) {
      const [error, value] = await kvStore.has(key)
      if (error) throw error
      return value ?? false
    },
    async keys(base) {
      const [error, value] = await kvStore.keys(base)
      if (error) throw error
      return value ?? []
    },
    async set(key, value) {
      const [error] = await kvStore.set(key, value)
      if (error) throw error
    },
  }
}
