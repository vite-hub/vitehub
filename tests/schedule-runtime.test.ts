import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryRuntimeScheduleStore,
  createMemoryScheduleRunStore,
  defineSchedule,
} from '@vite-hub/schedule'
import {
  type RuntimeScheduleWakeDriverContext,
  installScheduleRuntime,
} from '@vite-hub/schedule/runtime/driver'

test('the process runtime drains work registered by a schedule', { timeout: 1_000 }, async () => {
  let finishWork!: () => void
  const work = new Promise<void>((resolve) => {
    finishWork = resolve
  })
  let driverContext!: RuntimeScheduleWakeDriverContext
  let staticScheduleId!: string

  const controller = await installScheduleRuntime({
    createDriver(context) {
      driverContext = context
      return {
        reconcile(schedules) {
          staticScheduleId = schedules[0]!.id
          return Promise.resolve()
        },
      }
    },
    registry: {},
    runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
    scheduleRunStore: createMemoryScheduleRunStore(),
    staticRegistry: {
      babysitter: async () => defineSchedule({
        cron: '* * * * *',
        handler(schedule) {
          schedule.waitUntil(work)
        },
      }),
    },
  })

  await driverContext.wake({
    scheduleId: staticScheduleId,
    scheduledAt: new Date('2026-07-14T00:00:00.000Z'),
  })

  let closed = false
  const closing = controller.close().then(() => {
    closed = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)

  finishWork()
  await closing
  assert.equal(closed, true)
})
