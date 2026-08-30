import { readBody, type H3Event } from 'h3'

export interface RequestPayloadEvent {
  req: {
    json?: () => Promise<unknown>
  }
}

export async function readRequestPayload<TPayload = Record<string, never>>(
  event: RequestPayloadEvent,
  fallback = {} as TPayload,
): Promise<TPayload | unknown> {
  if (typeof event.req?.json === 'function')
    return await event.req.json().catch(() => fallback)

  // SAFETY: H3 owns the fallback parser, while the public helper requires the request shape it reads.
  return await readBody(event as H3Event).catch(() => fallback)
}
