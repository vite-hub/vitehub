import { consola } from 'consola'
import { getRequestEventResolver, safeUseRequest, setRequestEventResolver } from './runtime'

export interface DeferredTaskEvent {
  waitUntil?: (promise: Promise<unknown>) => void
  req?: {
    waitUntil?: (promise: Promise<unknown>) => void
  }
  context?: {
    waitUntil?: (promise: Promise<unknown>) => void
  }
}

let queuedDeferredTasks: Promise<unknown>[] = []
let deferredTaskEventResolver: (() => unknown) | undefined

function safeUseDeferredRequest<TEvent = unknown>(): TEvent | undefined {
  if (deferredTaskEventResolver)
    return deferredTaskEventResolver() as TEvent
  return safeUseRequest<TEvent>()
}

export function resolveWaitUntil(event?: DeferredTaskEvent | null) {
  if (typeof event?.waitUntil === 'function')
    return event.waitUntil.bind(event)
  if (typeof event?.req?.waitUntil === 'function')
    return event.req.waitUntil.bind(event.req)
  if (typeof event?.context?.waitUntil === 'function')
    return event.context.waitUntil.bind(event.context)
  return undefined
}

export function deferTask(thunk: () => Promise<unknown> | unknown, options: { errorMessage: string, logMessage: string, loggerTag: string }) {
  if (typeof thunk !== 'function')
    throw new TypeError('[vitehub] Deferred work requires a lazy thunk.')

  const event = safeUseDeferredRequest<DeferredTaskEvent>()
  const waitUntil = resolveWaitUntil(event)
  const task = Promise.resolve()
    .then(() => {
      const previousResolver = deferredTaskEventResolver
      const previousRequestResolver = getRequestEventResolver()
      if (event)
        deferredTaskEventResolver = () => event
      if (event)
        setRequestEventResolver(() => event)

      return Promise.resolve(thunk()).finally(() => {
        deferredTaskEventResolver = previousResolver
        setRequestEventResolver(previousRequestResolver)
      })
    })
    .catch((error) => {
      consola.withTag(options.loggerTag).error(options.logMessage, error)
      throw error
    })

  queuedDeferredTasks.push(task)
  if (waitUntil) waitUntil(task)
  else void task.catch(() => undefined)
}

export async function flushDeferredTasks() {
  const tasks = queuedDeferredTasks
  queuedDeferredTasks = []
  await Promise.allSettled(tasks)
}

export function setDeferredTaskEventResolver(resolver?: (() => unknown) | undefined) {
  deferredTaskEventResolver = resolver
  setRequestEventResolver(resolver)
}

export function resetDeferredTasks() {
  queuedDeferredTasks = []
  deferredTaskEventResolver = undefined
  setRequestEventResolver(undefined)
}
