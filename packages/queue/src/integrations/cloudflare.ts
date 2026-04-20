import { decodeQueueNameHex, encodeQueueNameHex } from "../internal/hex.ts"

const cloudflareQueueNamePrefix = "queue--"
const defaultCloudflareQueueBindingPrefix = "QUEUE"
const encodedCloudflareQueueNamePattern = /^queue--([0-9a-f]{2})+$/i

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
