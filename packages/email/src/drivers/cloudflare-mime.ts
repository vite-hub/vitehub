import { emailProviderError } from "../provider.ts";
import { addresses, bytesToBase64, formatAddress, stringToBase64 } from "./shared.ts";

import type { EmailAttachment, EmailMessage } from "../types.ts";

function safeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(value)) {
    throw emailProviderError(
      "cloudflare",
      "INVALID_OPTIONS",
      "Email headers cannot contain control characters.",
    );
  }
  return value;
}

function headerLine(name: string, value: string): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw emailProviderError(
      "cloudflare",
      "INVALID_OPTIONS",
      `${name} is not a valid email header name.`,
    );
  }
  const line = `${safeHeader(name)}: ${safeHeader(value)}`;
  if (new TextEncoder().encode(line).length > 998) {
    throw emailProviderError(
      "cloudflare",
      "INVALID_OPTIONS",
      `Cloudflare Email cannot encode an overlong ${name} header.`,
    );
  }
  return line;
}

function quotedParameter(value: string): string {
  return safeHeader(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function foldBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function encodedBody(value: string): string[] {
  const canonical = value.replace(/\r\n|\r|\n/g, "\r\n");
  return ["Content-Transfer-Encoding: base64", "", foldBase64(stringToBase64(canonical))];
}

function attachmentPart(boundary: string, value: EmailAttachment): string {
  const content = foldBase64(
    typeof value.content === "string"
      ? stringToBase64(value.content)
      : bytesToBase64(value.content),
  );
  const filename = quotedParameter(value.filename);
  return [
    `--${boundary}`,
    headerLine(
      "Content-Type",
      `${value.contentType ?? "application/octet-stream"}; name="${filename}"`,
    ),
    "Content-Transfer-Encoding: base64",
    headerLine(
      "Content-Disposition",
      `${value.disposition ?? "attachment"}; filename="${filename}"`,
    ),
    ...(value.cid ? [headerLine("Content-ID", `<${value.cid}>`)] : []),
    "",
    content,
  ].join("\r\n");
}

function bodyPart(message: EmailMessage): { contentType: string; lines: string[] } {
  if (message.html !== undefined && message.text !== undefined) {
    const boundary = `vitehub-alternative-${crypto.randomUUID()}`;
    return {
      contentType: `multipart/alternative; boundary="${boundary}"`,
      lines: [
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        ...encodedBody(message.text),
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        ...encodedBody(message.html),
        `--${boundary}--`,
      ],
    };
  }
  return {
    contentType:
      message.html !== undefined ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    lines: encodedBody(message.html ?? message.text ?? ""),
  };
}

/** Encodes validated envelope fields, body alternatives, and attachments as one MIME message. */
export function encodeCloudflareMimeMessage(message: EmailMessage, id: string): string {
  const boundary = `vitehub-${crypto.randomUUID()}`;
  const body = bodyPart(message);
  const headers = [
    headerLine("From", formatAddress(addresses(message.from)[0]!)),
    headerLine("To", addresses(message.to).map(formatAddress).join(", ")),
    ...(message.cc && addresses(message.cc).length > 0
      ? [headerLine("Cc", addresses(message.cc).map(formatAddress).join(", "))]
      : []),
    ...(message.replyTo && addresses(message.replyTo).length > 0
      ? [headerLine("Reply-To", addresses(message.replyTo).map(formatAddress).join(", "))]
      : []),
    headerLine("Subject", message.subject),
    headerLine("Date", new Date().toUTCString()),
    headerLine("Message-ID", id),
    "MIME-Version: 1.0",
    ...Object.entries(message.headers ?? {})
      .filter(([name]) => name.toLowerCase() !== "message-id")
      .map(([name, value]) => headerLine(name, value)),
  ];
  if (!message.attachments?.length)
    return [...headers, `Content-Type: ${body.contentType}`, ...body.lines].join("\r\n");
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: ${body.contentType}`,
    ...body.lines,
    ...message.attachments.map((value) => attachmentPart(boundary, value)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
