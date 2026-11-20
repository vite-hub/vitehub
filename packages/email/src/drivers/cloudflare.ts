import { emailProviderError, isEmailProviderError } from "../provider.ts";
import { encodeCloudflareMimeMessage } from "./cloudflare-mime.ts";
import {
  addresses,
  addressValue,
  applyUnsubscribe,
  requiredOption,
  validateAddresses,
  validateAttachments,
} from "./shared.ts";

import type { EmailDriver } from "../types.ts";

export interface CloudflareEmailBinding {
  send: (message: unknown) => Promise<void> | void;
}

export type CloudflareEmailMessageConstructor = new (
  from: string,
  to: string,
  raw: string,
) => unknown;

export interface CloudflareEmailDriverOptions {
  binding: CloudflareEmailBinding;
  EmailMessage?: CloudflareEmailMessageConstructor;
}

const messageIdAtom = "[!#$%&'*+\\-/=?^_`{|}~0-9A-Za-z]+";
const messageIdPattern = new RegExp(
  `^<${messageIdAtom}(?:\\.${messageIdAtom})*@${messageIdAtom}(?:\\.${messageIdAtom})*>$`,
);

async function sendWithCancellation(
  binding: CloudflareEmailBinding,
  value: unknown,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw emailProviderError(
      "cloudflare",
      "CANCELLED",
      "Cloudflare Email send was cancelled.",
      { cause: signal.reason, retryable: false },
    );
  }
  await binding.send(value);
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers ?? {}).find(
    ([header]) => header.toLowerCase() === normalizedName,
  )?.[1];
}

const transportOwnedHeaders = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);

function rejectTransportOwnedHeaders(headers: Record<string, string> | undefined): void {
  const header = Object.keys(headers ?? {}).find((name) =>
    transportOwnedHeaders.has(name.toLowerCase()),
  );
  if (header)
    throw emailProviderError(
      "cloudflare",
      "INVALID_OPTIONS",
      `Cloudflare Email owns the ${header} header.`,
    );
}

export default function cloudflareEmailDriver(options: CloudflareEmailDriverOptions): EmailDriver {
  requiredOption("cloudflare", options?.binding, "binding");
  const Constructor =
    options.EmailMessage ??
    (globalThis as typeof globalThis & { EmailMessage?: CloudflareEmailMessageConstructor })
      .EmailMessage;
  if (!Constructor)
    throw emailProviderError(
      "cloudflare",
      "NOT_CONFIGURED",
      "EmailMessage constructor is unavailable.",
    );
  return {
    name: "cloudflare",
    async send(message, context) {
      try {
        message = applyUnsubscribe(message, "cloudflare");
        validateAttachments("cloudflare", message);
        const unsupportedOption = (
          ["tags", "metadata"] as const
        ).find((option) => message[option] !== undefined);
        if (unsupportedOption) {
          return [emailProviderError(
            "cloudflare",
            "UNSUPPORTED",
            `Cloudflare Email does not support the ${unsupportedOption} option.`,
          ), undefined];
        }
        if (context.signal?.aborted) {
          return [emailProviderError(
            "cloudflare",
            "CANCELLED",
            "Cloudflare Email send was cancelled.",
            { retryable: false },
          ), undefined];
        }
        rejectTransportOwnedHeaders(message.headers);
        const unsupportedPayloads = [
          ["scheduledAt", "scheduled delivery"],
          ["idempotencyKey", "idempotency keys"],
        ] as const;
        for (const [key, description] of unsupportedPayloads) {
          if (message[key] !== undefined) {
            return [emailProviderError(
              "cloudflare",
              "UNSUPPORTED",
              `Cloudflare Email does not support ${description}.`,
            ), undefined];
          }
        }
        validateAddresses("cloudflare", message);
        const from = addresses(message.from)[0];
        const to = addresses(message.to);
        const recipients = [
          ...to,
          ...(message.cc ? addresses(message.cc) : []),
          ...(message.bcc ? addresses(message.bcc) : []),
        ];
        if (!from || to.length === 0)
          return [emailProviderError(
            "cloudflare",
            "INVALID_OPTIONS",
            "from and to are required.",
          ), undefined];
        if (recipients.length > 1)
          return [emailProviderError(
            "cloudflare",
            "UNSUPPORTED",
            "Cloudflare Email supports exactly one envelope recipient per message.",
          ), undefined];
        const customId = headerValue(message.headers, "message-id");
        if (customId !== undefined && !messageIdPattern.test(customId)) {
          return [emailProviderError(
            "cloudflare",
            "INVALID_OPTIONS",
            "Message-ID must use the <local@domain> form.",
          ), undefined];
        }
        const id = customId ?? `<${crypto.randomUUID()}@vitehub.email>`;
        const raw = encodeCloudflareMimeMessage(message, id);
        await sendWithCancellation(
          options.binding,
          new Constructor(addressValue(from).email, addressValue(recipients[0]!).email, raw),
          context.signal,
        );
        return [undefined, { at: new Date(), driver: "cloudflare", id }];
      } catch (cause) {
        if (isEmailProviderError(cause)) return [cause, undefined];
        return [emailProviderError(
          "cloudflare",
          "PROVIDER",
          "Cloudflare Email send failed.",
          { cause },
        ), undefined];
      }
    },
  };
}
