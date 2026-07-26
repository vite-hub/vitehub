import * as kvPackage from "@vite-hub/kv"

import { createScheduleKVStorage } from "./kv-storage.ts"

import type { ScheduleKVStorage } from "./kv-storage.ts"

export const scheduleKVStorage: ScheduleKVStorage = createScheduleKVStorage(kvPackage.kv)
