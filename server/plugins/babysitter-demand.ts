import { definePlugin } from 'nitro'
import {
  reconcileBabysitterWork,
  setBabysitterReconcilerWake,
} from '../babysitter.schedule.ts'
import { logOperationalError, logOperationalEvent } from '../babysitter.operations.ts'

const repairIntervalMs = 30_000

export default definePlugin((nitroApp) => {
  let closed = false
  let reason = 'startup'
  let rerun = false
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const scheduleRepair = () => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      wake('repair')
    }, repairIntervalMs)
    timer.unref?.()
  }

  const run = async () => {
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
          await reconcileBabysitterWork(currentReason)
        }
        catch (error) {
          logOperationalError('babysitter.reconcile.failed', error, { reason: currentReason })
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

  setBabysitterReconcilerWake(() => wake('owner-completed'))
  logOperationalEvent('babysitter.reconciler.started', { repairIntervalMs })
  wake('startup')

  nitroApp.hooks.hook('close', async () => {
    closed = true
    if (timer) clearTimeout(timer)
    timer = undefined
    setBabysitterReconcilerWake(() => {})
    await running
    logOperationalEvent('babysitter.reconciler.stopped', {})
  })
})
