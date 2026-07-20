import { encodeQueueNameHex } from "./hex.ts"

const cloudflareQueueNamePrefix = "queue--"
const cloudflareQueueNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
const cloudflareLegacyQueueDefinitionNamePattern = /^[a-z0-9]+-[a-z0-9]+$/
const cloudflareQueueDigestSuffixPattern = /-[0-9a-f]{32}$/
const maxCloudflareQueueNameLength = 63
const digestLength = 32

function digestCloudflareQueueName(name: string, namePrefix: string): string {
  const crypto = globalThis.process?.getBuiltinModule("node:crypto")
  if (!crypto) {
    throw new Error("Cloudflare queue name derivation requires the Node.js crypto module.")
  }
  return crypto.hash("sha256", JSON.stringify(["vitehub", "cloudflare", "queue", 1, namePrefix, name]), "hex").slice(0, digestLength)
}

function createBoundedCloudflareQueueName(name: string, namePrefix: string): string {
  const legacyName = `${namePrefix}${name}`
  if (
    namePrefix.endsWith("-")
    && cloudflareLegacyQueueDefinitionNamePattern.test(name)
    && !cloudflareQueueDigestSuffixPattern.test(name)
    && legacyName.length <= maxCloudflareQueueNameLength
  ) {
    return legacyName
  }

  const digest = digestCloudflareQueueName(name, namePrefix)
  const readableLength = maxCloudflareQueueNameLength - digest.length - 1
  const readable = legacyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, readableLength)
    .replace(/-+$/g, "") || "queue"
  return `${readable}-${digest}`
}

export function getCloudflareQueueName(name: string, namePrefix = ""): string {
  const queueName = `${namePrefix}${cloudflareQueueNamePrefix}${encodeQueueNameHex(name)}`
  if (!cloudflareQueueNamePattern.test(queueName)) {
    throw new TypeError(`Cloudflare queue name ${JSON.stringify(queueName)} must contain only letters, numbers, and dashes, and must start and end with a letter or number.`)
  }
  return queueName.length <= maxCloudflareQueueNameLength
    ? queueName
    : createBoundedCloudflareQueueName(name, namePrefix)
}
