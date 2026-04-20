const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const cloudflareQueueNamePrefix = "queue--"
const defaultCloudflareQueueBindingPrefix = "QUEUE"
const encodedCloudflareQueueNamePattern = /^queue--([0-9a-f]{2})+$/i

function encodeQueueNameHex(name: string) {
  return [...textEncoder.encode(name)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function decodeQueueNameHex(hex: string) {
  const bytes = hex.match(/.{2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? []
  if (!bytes.length || bytes.some(byte => !Number.isFinite(byte))) {
    return undefined
  }
  return textDecoder.decode(new Uint8Array(bytes))
}

export function getCloudflareQueueName(name: string): string {
  return `${cloudflareQueueNamePrefix}${encodeQueueNameHex(name)}`
}

export function getCloudflareQueueBindingName(name: string): string {
  const encoded = encodeQueueNameHex(name).toUpperCase()
  return encoded ? `${defaultCloudflareQueueBindingPrefix}_${encoded}` : defaultCloudflareQueueBindingPrefix
}

export function getCloudflareQueueDefinitionName(name: string): string {
  if (!encodedCloudflareQueueNamePattern.test(name)) {
    return name
  }

  return decodeQueueNameHex(name.slice(cloudflareQueueNamePrefix.length)) || name
}
