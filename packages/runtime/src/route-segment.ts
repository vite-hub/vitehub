const plainSegment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function encodeRouteSegment(value: string): string {
  if (plainSegment.test(value)) return value
  let encoded = "~"
  for (let index = 0; index < value.length; index++) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0")
  }
  return encoded
}

export function decodeRouteSegment(segment: string): string | undefined {
  if (plainSegment.test(segment)) return segment
  if (!/^~(?:[0-9a-f]{4})+$/.test(segment)) return
  let value = ""
  for (let index = 1; index < segment.length; index += 4) {
    value += String.fromCharCode(Number.parseInt(segment.slice(index, index + 4), 16))
  }
  return encodeRouteSegment(value) === segment ? value : undefined
}
