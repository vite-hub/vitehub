const plainSegment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function encodeRouteSegment(value: string): string {
  if (plainSegment.test(value)) return value
  const bytes = new TextEncoder().encode(value)
  return `~${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`
}

export function decodeRouteSegment(segment: string): string | undefined {
  if (plainSegment.test(segment)) return segment
  if (!/^~[A-Za-z0-9_-]+$/.test(segment)) return
  try {
    const base64 = segment.slice(1).replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return encodeRouteSegment(value) === segment ? value : undefined
  }
  catch {
    return undefined
  }
}
