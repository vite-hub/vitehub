import { readBody, type H3Event } from 'h3'

type RequestPayloadEvent = {
  req?: {
    json?: () => Promise<unknown>
  }
}

export async function readRequestPayload<TPayload = Record<string, never>>(
  event: RequestPayloadEvent,
  fallback = {} as TPayload,
): Promise<TPayload | unknown> {
  if (typeof event.req?.json === 'function')
    return await event.req.json().catch(() => fallback)

  return await readBody(event as H3Event).catch(() => fallback)
}
