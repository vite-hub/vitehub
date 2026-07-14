import { createKVRuntimeScheduleStore, createKVScheduleRunStore } from '@vite-hub/schedule'
import { installScheduleRuntime } from '@vite-hub/schedule/runtime/driver'
import { createProcessScheduleWakeDriver } from '@vite-hub/schedule/runtime/process'
import scheduleRegistry from '#vitehub/schedule/registry'
import { waitForBabysitterOwners } from './schedules/vitehub.ts'

function reportError(error: unknown) {
  console.error('[vitehub:schedule]', error instanceof Error ? error : new Error(String(error)))
}

const controller = await installScheduleRuntime({
  createDriver: createProcessScheduleWakeDriver({ intervalMs: 1_000 }),
  onError: reportError,
  registry: scheduleRegistry,
  runtimeScheduleStore: createKVRuntimeScheduleStore(),
  scheduleRunStore: createKVScheduleRunStore(),
  staticRegistry: scheduleRegistry,
})

// The process driver unrefs its polling timer, so the daemon needs one owning handle.
const keepAlive = setInterval(() => {}, 60_000)
let closing = false
async function close() {
  if (closing) return
  closing = true
  try {
    await controller.close()
    await waitForBabysitterOwners()
  }
  catch (error) {
    reportError(error)
    process.exitCode = 1
  }
  finally {
    clearInterval(keepAlive)
  }
}

process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
