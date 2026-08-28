import { emailProviderError } from "../provider.ts";

import type { EmailAddress, EmailAddressList, EmailMessage } from "../types.ts";

function isAddressArray(input: EmailAddressList): input is readonly EmailAddress[] {
  return Array.isArray(input);
}

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]" && !(value instanceof String);
}

export function addresses(input: EmailAddressList): EmailAddress[] {
  if (isAddressArray(input)) return [...input];
  return [input];
}

export function addressValue(input: EmailAddress): { email: string; name?: string } {
  if (!isString(input)) {
    return { ...input, email: input.email.trim() };
  }
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
    // SAFETY: this optional global is available in Node and omitted in web runtimes.
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
  if (
    message.attachments?.some(
      (value) => value.contentType !== undefined && value.contentType.trim() === "",
    )
  ) {
    throw emailProviderError(
      driver,
      "INVALID_OPTIONS",
      "attachment content types cannot be empty.",
    );
  }
}

function headerValues(headers: Record<string, string>, name: string): string[] {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers)
    .filter(([header]) => header.toLowerCase() === normalizedName)
    .map(([, value]) => value);
}

function hasListUnsubscribeTarget(value: string, target: string): boolean {
  return value.match(/<[^<>]*>/g)?.includes(`<${target}>`) === true;
}

export function applyUnsubscribe(message: EmailMessage, driver = "email"): EmailMessage {
  if (!message.unsubscribe) return message;
  const headers = { ...message.headers };
  const { oneClick } = message.unsubscribe;
  const mailto = message.unsubscribe.mailto?.trim();
  const url = message.unsubscribe.url?.trim();
  const oneClickEnabled = oneClick ?? Boolean(url);
  let normalizedUrl: string | undefined;
  if (mailto !== undefined && (/\p{Cc}/u.test(mailto) || !/^[^@\s<>,]+@[^@\s<>,]+$/.test(mailto))) {
    throw emailProviderError(
      driver,
      "INVALID_OPTIONS",
      "unsubscribe requires a valid mailto address.",
    );
  }
  if (url !== undefined) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (cause) {
      throw emailProviderError(driver, "INVALID_OPTIONS", "unsubscribe requires a valid URL.", {
        cause,
      });
    }
    if (oneClickEnabled && parsedUrl.protocol !== "https:") {
      throw emailProviderError(
        driver,
        "INVALID_OPTIONS",
        "one-click unsubscribe requires a valid HTTPS URL.",
      );
    }
    normalizedUrl = parsedUrl.href;
  } else if (oneClickEnabled) {
    throw emailProviderError(
      driver,
      "INVALID_OPTIONS",
      "one-click unsubscribe requires a valid HTTPS URL.",
    );
  }
  const values = [
    normalizedUrl ? `<${normalizedUrl}>` : undefined,
    mailto ? `<mailto:${mailto}>` : undefined,
  ].filter((value) => value !== undefined);
  const listUnsubscribeValues = headerValues(headers, "list-unsubscribe");
  const listUnsubscribePostValues = headerValues(headers, "list-unsubscribe-post");
  if (listUnsubscribeValues.length > 1 || listUnsubscribePostValues.length > 1) {
    throw emailProviderError(
      driver,
      "INVALID_OPTIONS",
      "unsubscribe headers cannot be repeated with case-variant names.",
    );
  }
  const existingListUnsubscribe = listUnsubscribeValues[0];
  const existingListUnsubscribePost = listUnsubscribePostValues[0];
  if (
    oneClickEnabled &&
    normalizedUrl &&
    existingListUnsubscribe !== undefined &&
    !hasListUnsubscribeTarget(existingListUnsubscribe, normalizedUrl)
  ) {
    throw emailProviderError(
      driver,
      "INVALID_OPTIONS",
      "one-click unsubscribe requires List-Unsubscribe to contain its HTTPS URL.",
    );
  }
  if (values.length > 0 && existingListUnsubscribe === undefined)
    headers["List-Unsubscribe"] = values.join(", ");
  if (existingListUnsubscribePost !== undefined) {
    const listUnsubscribe = existingListUnsubscribe ?? headers["List-Unsubscribe"];
    const targets = listUnsubscribe?.match(/<([^<>]*)>/g)?.map((target) => target.slice(1, -1));
    const webTargets = targets?.flatMap((target) => {
      try {
        const parsed = new URL(target);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? [parsed] : [];
      } catch {
        return [];
      }
    });
    if (
      existingListUnsubscribePost.trim() !== "List-Unsubscribe=One-Click" ||
      webTargets?.length !== 1 ||
      webTargets[0]?.protocol !== "https:"
    ) {
      throw emailProviderError(
        driver,
        "INVALID_OPTIONS",
        "List-Unsubscribe-Post requires exactly one HTTPS List-Unsubscribe target.",
      );
    }
  }
  if (oneClickEnabled && normalizedUrl && existingListUnsubscribePost === undefined)
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
