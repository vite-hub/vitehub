import { toResponse } from "@vite-hub/runtime/internal/response"

/** Queue deliveries use the handler's status and discard its response body. */
export function checkQueueHandlerResponse(value: unknown): void {
  const response = toResponse(value)
  discardUnreadBody(response.body)
  if (!response.ok) {
    const error = new Error(`Queue handler returned HTTP ${response.status}`)
    Object.assign(error, { status: response.status })
    throw error
  }
}

function discardUnreadBody(body: ReadableStream | null): void {
  if (!body || body.locked) return
  body.cancel().catch((error: unknown) => console.debug("[vitehub:queue] The Queue handler response body could not be cancelled.", error))
}
