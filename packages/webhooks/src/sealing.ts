import { importSealKey, sealWithKey, unsealWithKey } from "@vite-hub/env/seal"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { decodeViteHubBase64Key } from "@vite-hub/internal/secret"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { webhooksErrors } from "./errors.ts"

import type { SealKey } from "@vite-hub/env/seal"

/** The server variable with the key that seals the URL and secret of each member endpoint. */
export const webhooksKeyVariable = "VITEHUB_WEBHOOKS_KEY"

/** The server variables: Node's `process.env`, the Cloudflare bindings, and the values of `setEnv()` in app tests. */
export function serverEnv(): Record<string, unknown> {
  return { ...(typeof process === "object" && process?.env ? process.env : {}), ...getActiveCloudflareEnv(), ...getViteHubTestMode()?.env }
}

export function readString(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** The URL and secret of a member endpoint, as the sealed text holds them. */
export interface EndpointTarget {
  url: string
  secret: string
}

type KeyError = ReturnType<typeof webhooksErrors.WEBHOOKS_KEY_UNSET | typeof webhooksErrors.WEBHOOKS_KEY_INVALID>

let cached: { value: string, key: Promise<SealKey> } | undefined

/** App tests get a random key that lives until the next reset, so they need no variable. */
function testKey(): string | undefined {
  return getViteHubTestMode()?.backend("webhooks:key", () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))
}

async function endpointKey(): Promise<[KeyError, undefined] | [undefined, SealKey]> {
  const value = readString(serverEnv(), webhooksKeyVariable) ?? testKey()
  if (!value) return [webhooksErrors.WEBHOOKS_KEY_UNSET(), undefined]
  if (cached?.value !== value) {
    const raw = decodeViteHubBase64Key(value)
    if (raw?.byteLength !== 32) return [webhooksErrors.WEBHOOKS_KEY_INVALID({ problem: "the value is not 32 bytes in base64" }), undefined]
    cached = { value, key: importSealKey(raw) }
  }
  return [undefined, await cached.key]
}

/** The sealed text belongs to one endpoint row, so it cannot be copied to the row of another endpoint or owner. */
function additionalData(endpoint: { id: string, owner: string }): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`vitehub:webhooks:endpoint:${JSON.stringify([endpoint.id, endpoint.owner])}`)
}

export async function sealEndpoint(endpoint: { id: string, owner: string }, target: EndpointTarget): Promise<[KeyError, undefined] | [undefined, string]> {
  const [error, key] = await endpointKey()
  if (error) return [error, undefined]
  return [undefined, await sealWithKey(key, additionalData(endpoint), JSON.stringify({ url: target.url, secret: target.secret }))]
}

export async function unsealEndpoint(endpoint: { id: string, owner: string, sealed: string }): Promise<[KeyError, undefined] | [undefined, EndpointTarget]> {
  const [error, key] = await endpointKey()
  if (error) return [error, undefined]
  let text: string
  try {
    text = await unsealWithKey(key, additionalData(endpoint), endpoint.sealed)
  }
  catch {
    return [webhooksErrors.WEBHOOKS_KEY_INVALID({ problem: "it is not the key that sealed this endpoint" }), undefined]
  }
  const value: unknown = JSON.parse(text)
  const url: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "url") : undefined
  const secret: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "secret") : undefined
  if (typeof url !== "string" || typeof secret !== "string") return [webhooksErrors.WEBHOOKS_KEY_INVALID({ problem: "the sealed endpoint has no URL or secret" }), undefined]
  return [undefined, { url, secret }]
}

/**
 * Seals `text` with `VITEHUB_WEBHOOKS_KEY` for another package that keeps a receiver's secret before it becomes a member
 * endpoint, such as the setup code of Comments Send. `label` binds the sealed text to one row: open it with the same one.
 */
export async function sealWebhooksText(label: string, text: string): Promise<[KeyError, undefined] | [undefined, string]> {
  const [error, key] = await endpointKey()
  if (error) return [error, undefined]
  return [undefined, await sealWithKey(key, new TextEncoder().encode(`vitehub:webhooks:text:${label}`), text)]
}

/** Opens the text that `sealWebhooksText()` sealed with the same `label`. */
export async function unsealWebhooksText(label: string, sealed: string): Promise<[KeyError, undefined] | [undefined, string]> {
  const [error, key] = await endpointKey()
  if (error) return [error, undefined]
  try {
    return [undefined, await unsealWithKey(key, new TextEncoder().encode(`vitehub:webhooks:text:${label}`), sealed)]
  }
  catch {
    return [webhooksErrors.WEBHOOKS_KEY_INVALID({ problem: "it is not the key that sealed this text" }), undefined]
  }
}

export const sealedMemberBodyPrefix = "vitehub:sealed-member-body:"

export function memberBodyLabel(webhook: string, event: string): string {
  return `delivery:${JSON.stringify([webhook, event])}`
}
