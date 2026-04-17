import { encodeQueueNameHex } from "./encoding.ts"

const vercelTopicPattern = /^[A-Za-z0-9_-]+$/
const encodedVercelTopicPattern = /^queue__([0-9a-f]{2})+$/i

export function getVercelQueueTopicName(name: string): string {
  if (encodedVercelTopicPattern.test(name)) {
    throw new TypeError("Vercel queue topic names matching `queue__<hex>` are reserved by @vitehub/queue.")
  }
  if (vercelTopicPattern.test(name)) return name
  const encoded = encodeQueueNameHex(name)
  return encoded ? `queue__${encoded}` : "queue"
}
