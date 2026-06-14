import { encodeNameHex } from "@vite-hub/internal/integrations/hex"

const vercelQueueTopicPrefix = "topic--"

export function getVercelQueueTopicName(name: string): string {
  return `${vercelQueueTopicPrefix}${encodeNameHex(name)}`
}
