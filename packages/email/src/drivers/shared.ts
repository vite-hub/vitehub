import { emailProviderError } from "../provider.ts"

import type { EmailAddress, EmailAddressList, EmailMessage } from "../types.ts"

export function addresses(input: EmailAddressList): EmailAddress[] {
  return Array.isArray(input) ? [...input] : [input as EmailAddress]
}

export function addressValue(input: EmailAddress): { email: string, name?: string } {
  if (typeof input !== "string") return input
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(input)
  if (!match) return { email: input.trim() }
  const phrase = match[1]!
  const name = phrase.startsWith('"') && phrase.endsWith('"')
    ? phrase.slice(1, -1).replace(/\\(.)/g, "$1")
    : phrase
  return { email: match[2]!, ...(name ? { name } : {}) }
}

export function formatAddress(input: EmailAddress): string {
  const address = addressValue(input)
  return address.name ? `"${address.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" <${address.email}>` : address.email
}

export function bytesToBase64(value: Uint8Array): string {
  const Buffer = (globalThis as typeof globalThis & { Buffer?: { from: (value: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer
  if (Buffer) return Buffer.from(value).toString("base64")
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function stringToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
}

export function requiredOption(driver: string, value: unknown, name: string): asserts value {
  if (!value) throw emailProviderError(driver, "INVALID_OPTIONS", `${name} is required.`)
}

export function applyPersonalization(driver: string, message: EmailMessage): EmailMessage {
  if (!message.personalizations?.length) return message
  if (message.personalizations.length > 1) {
    throw emailProviderError(driver, "UNSUPPORTED", `${driver} supports one personalization per message.`)
  }
  const personalization = message.personalizations[0]!
  if (personalization.variables !== undefined || personalization.sendAt !== undefined || personalization.customArgs !== undefined) {
    throw emailProviderError(driver, "UNSUPPORTED", `${driver} does not support personalization variables, sendAt, or customArgs.`)
  }
  return {
    ...message,
    bcc: personalization.bcc ?? message.bcc,
    cc: personalization.cc ?? message.cc,
    subject: personalization.subject ?? message.subject,
    to: personalization.to,
  }
}
