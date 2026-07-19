import { decodeQueueNameHex, encodeQueueNameHex } from "../internal/hex.ts"

const cloudflareQueueNamePrefix = "queue--"
const defaultCloudflareQueueBindingPrefix = "QUEUE"
const encodedCloudflareQueueNamePattern = /^queue--([0-9a-f]{2})+$/i
const cloudflareQueueNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

export function getCloudflareQueueName(name: string, namePrefix = ""): string {
  const queueName = `${namePrefix}${cloudflareQueueNamePrefix}${encodeQueueNameHex(name)}`
  if (!cloudflareQueueNamePattern.test(queueName)) {
    throw new TypeError(`Cloudflare queue name ${JSON.stringify(queueName)} must contain only letters, numbers, and dashes, and must start and end with a letter or number.`)
  }
  if (queueName.length > 63) {
    throw new TypeError(`Cloudflare queue name ${JSON.stringify(queueName)} must be at most 63 characters.`)
  }
  return queueName
}

export function getCloudflareQueueBindingName(name: string): string {
  const encoded = encodeQueueNameHex(name).toUpperCase()
  return encoded ? `${defaultCloudflareQueueBindingPrefix}_${encoded}` : defaultCloudflareQueueBindingPrefix
}

export function getCloudflareQueueDefinitionName(name: string, namePrefix = ""): string {
  const encodedName = namePrefix && name.startsWith(namePrefix) ? name.slice(namePrefix.length) : name
  if (!encodedCloudflareQueueNamePattern.test(encodedName)) {
    return name
  }

  return decodeQueueNameHex(encodedName.slice(cloudflareQueueNamePrefix.length)) || name
}
