import { decodeQueueNameHex, encodeQueueNameHex } from "../internal/hex.ts"

const cloudflareQueueNamePrefix = "queue--"
const defaultCloudflareQueueBindingPrefix = "QUEUE"
const encodedCloudflareQueueNamePattern = /^queue--([0-9a-f]{2})+$/i

export function getCloudflareQueueBindingName(name: string): string {
  const encoded = encodeQueueNameHex(name).toUpperCase()
  return encoded ? `${defaultCloudflareQueueBindingPrefix}_${encoded}` : defaultCloudflareQueueBindingPrefix
}

export function getCloudflareQueueDefinitionName(name: string, namePrefix = ""): string {
  const encodedName = namePrefix && name.startsWith(namePrefix) ? name.slice(namePrefix.length) : name
  if (!encodedCloudflareQueueNamePattern.test(encodedName)) {
    return encodedName
  }

  return decodeQueueNameHex(encodedName.slice(cloudflareQueueNamePrefix.length)) || name
}
