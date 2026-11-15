import { deriveSecret } from "#vitehub/env/server"
import type { H3Event } from "h3"

export async function contentLabel(event: H3Event, id: string) {
  const key = await deriveSecret("drop:content-origin", event)
  return `${id}-${key.slice(0, 8)}`
}

export async function rootLabel(request: { event: H3Event }) {
  return await deriveSecret("drop:root-origin", request.event)
}

export async function legacyLabel(event: H3Event, root: string) {
  return await deriveSecret("drop:legacy", event, root)
}
