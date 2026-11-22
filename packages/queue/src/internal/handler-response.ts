import { toResponse } from "@vite-hub/runtime/internal/response"

/** Queue deliveries use the handler's status and discard its response body. */
export function checkQueueHandlerResponse(value: unknown): void {
  const response = toResponse(value)
  void response.body?.cancel().catch(() => {})
  if (!response.ok) {
    const error = new Error(`Queue handler returned HTTP ${response.status}`)
    Object.assign(error, { status: response.status })
    throw error
  }
}
