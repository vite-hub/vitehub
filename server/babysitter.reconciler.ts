type ReconcilerOptions = {
  onDrained: () => void
  onError: (error: unknown, reason: string) => void
  onQuiesce: () => void
  reconcile: (reason: string) => Promise<void>
  repairIntervalMs: number
  waitForOwners: () => Promise<void>
}

export type BabysitterDrainStatus = 'accepting' | 'drained' | 'draining' | 'failed'

type DrainSignalTarget = {
  off: (event: 'SIGUSR2', listener: () => void) => unknown
  on: (event: 'SIGUSR2', listener: () => void) => unknown
}

export function createBabysitterReconciler(options: ReconcilerOptions) {
  let closed = false
  let drainPromise: Promise<void> | undefined
  let reason = 'startup'
  let rerun = false
  let running: Promise<void> | undefined
  let status: BabysitterDrainStatus = 'accepting'
  let timer: ReturnType<typeof setTimeout> | undefined

  const scheduleRepair = () => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      wake('repair')
    }, options.repairIntervalMs)
    timer.unref?.()
  }

  const run = async () => {
    if (closed) return
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      do {
        rerun = false
        const currentReason = reason
        reason = 'coalesced'
        try {
          await options.reconcile(currentReason)
        }
        catch (error) {
          options.onError(error, currentReason)
        }
      } while (!closed && rerun)
    })().finally(() => {
      running = undefined
      if (!closed && rerun) queueMicrotask(() => void run())
      else scheduleRepair()
    })
    return running
  }

  const wake = (nextReason: string) => {
    if (closed) return
    reason = nextReason
    if (timer) clearTimeout(timer)
    timer = undefined
    if (running) {
      rerun = true
      return
    }
    queueMicrotask(() => void run())
  }

  const drain = () => {
    if (drainPromise) return drainPromise
    drainPromise = (async () => {
      status = 'draining'
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      options.onQuiesce()
      await running
      await options.waitForOwners()
      status = 'drained'
      options.onDrained()
    })().catch((error) => {
      status = 'failed'
      throw error
    })
    return drainPromise
  }

  return { drain, status: () => status, wake }
}

let drainStatusHandler: (() => BabysitterDrainStatus) | undefined

export function registerBabysitterDrainStatus(handler: () => BabysitterDrainStatus) {
  drainStatusHandler = handler
}

export function getBabysitterDrainStatus(): BabysitterDrainStatus | 'starting' {
  return drainStatusHandler?.() ?? 'starting'
}

export function listenForBabysitterDrainSignal(
  target: DrainSignalTarget,
  drain: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  let started = false
  const listener = () => {
    if (started) return
    started = true
    void drain().catch(onError)
  }
  target.on('SIGUSR2', listener)
  return () => target.off('SIGUSR2', listener)
}
