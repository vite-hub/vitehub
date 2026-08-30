import { definePlugin } from 'nitro'
import { createProcessReconciler } from 'vite-hub/runtime/node'
import {
  reconcileBabysitterWork,
  setBabysitterReconcilerWake,
} from '../babysitter.schedule.ts'
import { logOperationalError, logOperationalEvent } from '../babysitter.operations.ts'

const repairIntervalMs = 30_000

export default definePlugin((nitroApp) => {
  const reconciler = createProcessReconciler({
    intervalMs: repairIntervalMs,
    onError: (error, reason) => logOperationalError('babysitter.reconcile.failed', error, { reason }),
    run: reconcileBabysitterWork,
  })

  setBabysitterReconcilerWake(() => reconciler.wake('owner-completed'))
  logOperationalEvent('babysitter.reconciler.started', { repairIntervalMs })
  reconciler.wake('startup')

  nitroApp.hooks.hook('close', async () => {
    setBabysitterReconcilerWake(() => {})
    await reconciler.close()
    logOperationalEvent('babysitter.reconciler.stopped', {})
  })
})
