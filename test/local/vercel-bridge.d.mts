import type { ServerResponse } from "node:http"

export function writeWebResponse(res: ServerResponse, response: Response): Promise<void>

export function createVercelBridge(options: { env?: Record<string, string>, outputDir: string, port: number }): Promise<{ close: () => Promise<void> }>
