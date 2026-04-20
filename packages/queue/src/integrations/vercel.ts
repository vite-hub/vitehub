const textEncoder = new TextEncoder()

const vercelQueueTopicPrefix = "topic--"

function encodeQueueNameHex(name: string) {
  return [...textEncoder.encode(name)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

export function getVercelQueueTopicName(name: string): string {
  return `${vercelQueueTopicPrefix}${encodeQueueNameHex(name)}`
}
