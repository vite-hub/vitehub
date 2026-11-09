import { createLogBuffer, type LogSource } from "vite-hub/logs"
import { initLogger, useLogger } from "evlog"

export const buffer = createLogBuffer()
initLogger({ drain: buffer.drain })
export const source: LogSource = buffer.source
export const log = useLogger
