import { emailProviderError } from "../provider.ts";

import type { EmailAddress, EmailAddressList, EmailMessage } from "../types.ts";

export function addresses(input: EmailAddressList): EmailAddress[] {
  return Array.isArray(input) ? [...input] : [input as EmailAddress];
}

export function addressValue(input: EmailAddress): { email: string; name?: string } {
  if (typeof input !== "string") return { ...input, email: input.email.trim() };
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(input);
  if (!match) return { email: input.trim() };
  const phrase = match[1]!;
  const name =
    phrase.startsWith('"') && phrase.endsWith('"')
      ? phrase.slice(1, -1).replace(/\\(.)/g, "$1")
      : phrase;
  return { email: match[2]!.trim(), ...(name ? { name } : {}) };
}

export function validateAddresses(driver: string, message: EmailMessage): void {
  const fields = [message.from, message.to, message.cc, message.bcc, message.replyTo];
  if (
    fields.some(
      (field) =>
        field !== undefined && addresses(field).some((value) => !addressValue(value).email),
    )
  ) {
    throw emailProviderError(driver, "INVALID_OPTIONS", "email addresses cannot be empty.");
  }
}

export function formatAddress(input: EmailAddress): string {
  const address = addressValue(input);
  return address.name
    ? `"${address.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" <${address.email}>`
    : address.email;
}

export function bytesToBase64(value: Uint8Array): string {
  const Buffer = (
    globalThis as typeof globalThis & {
      Buffer?: { from: (value: Uint8Array) => { toString: (encoding: string) => string } };
    }
  ).Buffer;
  if (Buffer) return Buffer.from(value).toString("base64");
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function stringToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function requiredOption(driver: string, value: unknown, name: string): asserts value {
  if (!value) throw emailProviderError(driver, "INVALID_OPTIONS", `${name} is required.`);
}

export function validateAttachments(driver: string, message: EmailMessage): void {
  if (message.attachments?.some((value) => value.filename.trim() === "")) {
    throw emailProviderError(driver, "INVALID_OPTIONS", "attachment filenames cannot be empty.");
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((header) => header.toLowerCase() === normalizedName);
}

export function applyUnsubscribe(message: EmailMessage, driver = "email"): EmailMessage {
  if (!message.unsubscribe) return message;
  const headers = { ...message.headers };
  const { oneClick } = message.unsubscribe;
  const mailto = message.unsubscribe.mailto?.trim();
  const url = message.unsubscribe.url?.trim();
  if (oneClick) {
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = url ? new URL(url) : undefined;
    } catch {}
    if (parsedUrl?.protocol !== "https:") {
      throw emailProviderError(
        driver,
        "INVALID_OPTIONS",
        "one-click unsubscribe requires a valid HTTPS URL.",
      );
    }
  }
  const values = [url ? `<${url}>` : undefined, mailto ? `<mailto:${mailto}>` : undefined].filter(
    (value) => value !== undefined,
  );
  if (values.length > 0 && !hasHeader(headers, "list-unsubscribe"))
    headers["List-Unsubscribe"] = values.join(", ");
  if ((oneClick ?? Boolean(url)) && url && !hasHeader(headers, "list-unsubscribe-post"))
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return { ...message, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
}

export function applyPersonalization(driver: string, message: EmailMessage): EmailMessage {
  if (!message.personalizations?.length) return message;
  if (message.personalizations.length > 1) {
    throw emailProviderError(
      driver,
      "UNSUPPORTED",
      `${driver} supports one personalization per message.`,
    );
  }
  const personalization = message.personalizations[0]!;
  if (
    personalization.variables !== undefined ||
    personalization.sendAt !== undefined ||
    personalization.customArgs !== undefined
  ) {
    throw emailProviderError(
      driver,
      "UNSUPPORTED",
      `${driver} does not support personalization variables, sendAt, or customArgs.`,
    );
  }
  return {
    ...message,
    bcc: personalization.bcc ?? message.bcc,
    cc: personalization.cc ?? message.cc,
    subject: personalization.subject ?? message.subject,
    to: personalization.to,
  };
}
