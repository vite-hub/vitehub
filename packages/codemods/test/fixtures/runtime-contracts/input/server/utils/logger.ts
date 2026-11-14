import { createLogBuffer, initLogger, type LogSource, useLogger } from "vite-hub/logs"

export const buffer = createLogBuffer()
initLogger({ drain: buffer.drain })
export const source: LogSource = buffer.source
export const log = useLogger
