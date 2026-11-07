import registry from '#vitehub/schedule/registry'
import { createKVScheduleRunStore } from '@vite-hub/schedule/runtime'
import { scheduleKVStorage } from '@vite-hub/schedule/runtime/kv'
import { installProcessScheduleRuntime } from '@vite-hub/schedule/runtime/process'

const controller = await installProcessScheduleRuntime({
  onError: error => console.error(error),
  registry,
  scheduleRunStore: createKVScheduleRunStore({ kvStore: scheduleKVStorage }),
})

process.once('SIGTERM', () => void controller.close())
