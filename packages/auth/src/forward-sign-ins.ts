import { AsyncLocalStorage } from "node:async_hooks"

export const forwardSignIns: AsyncLocalStorage<true> = new AsyncLocalStorage()
