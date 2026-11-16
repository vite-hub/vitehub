import { getStandardContext } from '@vite-hub/runtime/internal/h3'

import type { ViteHubContext } from '@vite-hub/runtime'

/** Read the JSON body of the request in the event's Standard Context, or `fallback` when the body is not JSON. */
export async function readRequestPayload(
  event: ViteHubContext,
  fallback: unknown = {},
): Promise<unknown> {
  return await getStandardContext(event).req.json().catch(() => fallback)
}
