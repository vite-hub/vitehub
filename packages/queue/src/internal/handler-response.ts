import { toResponse } from "@vite-hub/runtime"

/** Queue deliveries use the handler's status and discard its response body. */
export function checkQueueHandlerResponse(value: unknown): void {
  const response = toResponse(value)
  // Release unread streams without letting cleanup delay or retry a delivery.
  void response.body?.cancel().catch(() => {})
  if (!response.ok) {
    const error = new Error(`Queue handler returned HTTP ${response.status}`)
    Object.assign(error, { status: response.status })
    throw error
  }
}
