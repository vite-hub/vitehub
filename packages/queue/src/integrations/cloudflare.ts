import { decodeNameHex, encodeNameHex } from "@vite-hub/internal/integrations/hex"

const cloudflareQueueNamePrefix = "queue--"
const defaultCloudflareQueueBindingPrefix = "QUEUE"
const encodedCloudflareQueueNamePattern = /^queue--([0-9a-f]{2})+$/i

export function getCloudflareQueueName(name: string): string {
  return `${cloudflareQueueNamePrefix}${encodeNameHex(name)}`
}

export function getCloudflareQueueBindingName(name: string): string {
  const encoded = encodeNameHex(name).toUpperCase()
  return encoded ? `${defaultCloudflareQueueBindingPrefix}_${encoded}` : defaultCloudflareQueueBindingPrefix
}

export function getCloudflareQueueDefinitionName(name: string): string {
  if (!encodedCloudflareQueueNamePattern.test(name)) {
    return name
  }

  return decodeNameHex(name.slice(cloudflareQueueNamePrefix.length)) || name
}
