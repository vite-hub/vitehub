declare module "@vitehub/blob" {
  export const blob: {
    del: (path: string) => Promise<unknown>
    get: (path: string) => Promise<Blob | string | undefined>
    head: (path: string) => Promise<unknown>
    list: (prefix?: string) => Promise<unknown>
    put: (path: string, value: string | Blob, options?: Record<string, unknown>) => Promise<unknown>
  }
}

declare module "@vitehub/db/drizzle" {
  export const databases: Record<string, { db?: { execute?: (query: string) => Promise<unknown>, run?: (query: string) => Promise<unknown> } }>
}

declare module "@vitehub/kv" {
  export const kv: {
    del: (key: string) => Promise<unknown>
    get: (key: string) => Promise<unknown>
    has: (key: string) => Promise<boolean>
    keys: (prefix?: string) => Promise<string[]>
    set: (key: string, value: unknown) => Promise<unknown>
  }
}
