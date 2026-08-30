import { definePlugin } from 'nitro'
import { createProcessReconciler, type ProcessReconcilerStatus } from 'vite-hub/runtime/node'
import {
  reconcileBabysitterWork,
  setBabysitterReconcilerWake,
} from '../babysitter.schedule.ts'
import { logOperationalError, logOperationalEvent } from '../babysitter.operations.ts'

const repairIntervalMs = 30_000
let readDrainStatus: (() => ProcessReconcilerStatus) | undefined

export function getBabysitterDrainStatus() {
  return readDrainStatus?.() || 'starting'
}

export default definePlugin((nitroApp) => {
  const reconciler = createProcessReconciler({
    intervalMs: repairIntervalMs,
    onDrained: () => logOperationalEvent('babysitter.reconciler.stopped', {}),
    onError: (error, reason) => logOperationalError('babysitter.reconcile.failed', error, { reason }),
    onQuiesce: () => setBabysitterReconcilerWake(() => {}),
    run: reconcileBabysitterWork,
    signal: 'SIGUSR2',
  })

  readDrainStatus = reconciler.status
  setBabysitterReconcilerWake(() => reconciler.wake('owner-completed'))
  logOperationalEvent('babysitter.reconciler.started', { repairIntervalMs })
  reconciler.wake('startup')

  nitroApp.hooks.hook('close', async () => {
    await reconciler.close()
  })
})
