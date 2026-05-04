import type { ChatRuntimeContext, ChatRuntimeName, ChatWaitUntil } from "../types.ts"

export function createMemo() {
  const values = new Map<string, unknown>()
  return <T>(key: string, create: () => T): T => {
    if (values.has(key)) {
      return values.get(key) as T
    }

    const value = create()
    values.set(key, value)
    return value
  }
}

export function createChatRuntimeContext(options: Omit<ChatRuntimeContext, "memo" | "runtime" | "waitUntil"> & {
  runtime: ChatRuntimeName
  waitUntil?: ChatWaitUntil
}): ChatRuntimeContext {
  const waitUntil = options.waitUntil || (() => {})
  return {
    ...options,
    memo: createMemo(),
    waitUntil,
  }
}
