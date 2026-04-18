import { readBody, type H3Event } from 'h3'

export async function readRequestPayload<TPayload = Record<string, never>>(
  event: H3Event,
  fallback = {} as TPayload,
): Promise<TPayload | unknown> {
  try {
    return await readBody(event)
  }
  catch {}

  if (typeof event.req?.json === 'function')
    return await event.req.json().catch(() => fallback)

  return fallback
}
