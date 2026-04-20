const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeQueueNameHex(name: string): string {
  return [...textEncoder.encode(name)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

export function decodeQueueNameHex(hex: string): string | undefined {
  const bytes = hex.match(/.{2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? []
  if (!bytes.length || bytes.some(byte => !Number.isFinite(byte))) {
    return undefined
  }
  return textDecoder.decode(new Uint8Array(bytes))
}
