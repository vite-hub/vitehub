import { emailProviderError } from "../provider.ts"

import type { EmailAddress, EmailAddressList } from "../types.ts"

export function addresses(input: EmailAddressList): EmailAddress[] {
  return Array.isArray(input) ? [...input] : [input as EmailAddress]
}

export function addressValue(input: EmailAddress): { email: string, name?: string } {
  if (typeof input !== "string") return input
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(input)
  return match ? { email: match[2]!, ...(match[1] ? { name: match[1] } : {}) } : { email: input.trim() }
}

export function formatAddress(input: EmailAddress): string {
  const address = addressValue(input)
  return address.name ? `${address.name} <${address.email}>` : address.email
}

export function bytesToBase64(value: Uint8Array): string {
  const Buffer = (globalThis as typeof globalThis & { Buffer?: { from: (value: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer
  if (Buffer) return Buffer.from(value).toString("base64")
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function requiredOption(driver: string, value: unknown, name: string): asserts value {
  if (!value) throw emailProviderError(driver, "INVALID_OPTIONS", `${name} is required.`)
}
