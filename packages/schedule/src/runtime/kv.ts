import * as kvPackage from "@vite-hub/kv"

import { createScheduleKVStorage } from "./store.ts"

import type { ScheduleKVStorage } from "./store.ts"

export const scheduleKVStorage: ScheduleKVStorage = createScheduleKVStorage(kvPackage.kv)
