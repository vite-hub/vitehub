import { definePlugin } from 'nitro'
import {
  reconcileBabysitterWork,
  setBabysitterReconcilerWake,
  waitForBabysitterOwners,
} from '../babysitter.schedule.ts'
import { logOperationalError, logOperationalEvent } from '../babysitter.operations.ts'
import {
  createBabysitterReconciler,
  listenForBabysitterDrainSignal,
  registerBabysitterDrainStatus,
} from '../babysitter.reconciler.ts'

const repairIntervalMs = 30_000

export default definePlugin((nitroApp) => {
  const reconciler = createBabysitterReconciler({
    onDrained: () => logOperationalEvent('babysitter.reconciler.stopped', {}),
    onError: (error, reason) => logOperationalError('babysitter.reconcile.failed', error, { reason }),
    onQuiesce: () => setBabysitterReconcilerWake(() => {}),
    reconcile: reconcileBabysitterWork,
    repairIntervalMs,
    waitForOwners: waitForBabysitterOwners,
  })

  const removeDrainSignalListener = listenForBabysitterDrainSignal(
    process,
    reconciler.drain,
    error => logOperationalError('babysitter.reconciler.drain.failed', error, { signal: 'SIGUSR2' }),
  )
  registerBabysitterDrainStatus(reconciler.status)
  setBabysitterReconcilerWake(() => reconciler.wake('owner-completed'))
  logOperationalEvent('babysitter.reconciler.started', { repairIntervalMs })
  reconciler.wake('startup')

  nitroApp.hooks.hook('close', async () => {
    try {
      await reconciler.drain()
    }
    finally {
      removeDrainSignalListener()
    }
  })
})
