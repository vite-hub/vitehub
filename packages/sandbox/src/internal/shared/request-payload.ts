export interface RequestPayloadEvent {
  req: {
    json: () => Promise<unknown>
  }
}

export async function readRequestPayload(
  event: RequestPayloadEvent,
  fallback: unknown = {},
): Promise<unknown> {
  return await event.req.json().catch(() => fallback)
}
