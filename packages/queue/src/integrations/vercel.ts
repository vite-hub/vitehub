import { encodeQueueNameHex } from "../internal/hex.ts"

const vercelQueueTopicPrefix = "topic--"

export function getVercelQueueTopicName(name: string): string {
  return `${vercelQueueTopicPrefix}${encodeQueueNameHex(name)}`
}
