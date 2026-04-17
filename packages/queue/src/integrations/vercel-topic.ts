const vercelTopicPattern = /^[A-Za-z0-9_-]+$/
const encodedVercelTopicPattern = /^queue__([0-9a-f]{2})+$/i

function encodeQueueName(name: string): string {
  return [...new TextEncoder().encode(name)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

export function getVercelQueueTopicName(name: string): string {
  if (encodedVercelTopicPattern.test(name)) {
    throw new TypeError("Vercel queue topic names matching `queue__<hex>` are reserved by @vitehub/queue.")
  }
  if (vercelTopicPattern.test(name)) return name
  const encoded = encodeQueueName(name)
  return encoded ? `queue__${encoded}` : "queue"
}
