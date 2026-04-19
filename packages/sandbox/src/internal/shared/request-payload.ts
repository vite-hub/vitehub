import { readBody, type H3Event } from 'h3'

function parseJsonLike<TPayload>(
  value: unknown,
  fallback: TPayload,
): TPayload | unknown {
  if (value == null)
    return fallback

  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    }
    catch {
      return fallback
    }
  }

  if (value instanceof Uint8Array)
    return parseJsonLike(new TextDecoder().decode(value), fallback)

  if (value instanceof ArrayBuffer)
    return parseJsonLike(new TextDecoder().decode(new Uint8Array(value)), fallback)

  if (ArrayBuffer.isView(value))
    return parseJsonLike(new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), fallback)

  if (typeof value === 'object')
    return value

  return fallback
}

async function readRequestJson<TPayload>(
  request: { clone?: () => { json?: () => Promise<unknown> }, json?: () => Promise<unknown> } | undefined,
  fallback: TPayload,
): Promise<TPayload | unknown> {
  try {
    const source = request?.clone?.() ?? request
    if (typeof source?.json !== 'function')
      return fallback

    return await source.json().catch(() => fallback)
  }
  catch {
    return fallback
  }
}

export async function readRequestPayload<TPayload = Record<string, never>>(
  event: H3Event,
  fallback = {} as TPayload,
): Promise<TPayload | unknown> {
  try {
    return await readBody(event)
  }
  catch {}

  const requestPayload = await readRequestJson(event.req, fallback)
  if (requestPayload !== fallback)
    return requestPayload

  const cloudflarePayload = await readRequestJson((event as any).context?._platform?.cloudflare?.request, fallback)
  if (cloudflarePayload !== fallback)
    return cloudflarePayload

  const platformPayload = await readRequestJson((event as any).context?.cloudflare?.request, fallback)
  if (platformPayload !== fallback)
    return platformPayload

  const rawBody = parseJsonLike((event as any).node?.req?.body, fallback)
  if (rawBody !== fallback)
    return rawBody

  return fallback
}
