const vercelTopicPattern = /^[A-Za-z0-9_-]+$/

function encodeQueueName(name: string): string {
  return [...new TextEncoder().encode(name)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

export function getVercelQueueTopicName(name: string): string {
  if (vercelTopicPattern.test(name)) return name
  const encoded = encodeQueueName(name)
  return encoded ? `queue_${encoded}` : "queue"
}
