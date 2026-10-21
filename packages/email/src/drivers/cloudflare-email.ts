import { emailProviderError, isEmailProviderError } from "../provider.ts";
import { encodeCloudflareMimeMessage } from "./cloudflare-mime.ts";
import {
  addresses,
  addressValue,
  applyPersonalization,
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
      "cloudflare-email",
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
      "cloudflare-email",
      "INVALID_OPTIONS",
      `Cloudflare Email owns the ${header} header.`,
    );
}

export default function cloudflareEmailDriver(options: CloudflareEmailDriverOptions): EmailDriver {
  requiredOption("cloudflare-email", options?.binding, "binding");
  const Constructor =
    options.EmailMessage ??
    (globalThis as typeof globalThis & { EmailMessage?: CloudflareEmailMessageConstructor })
      .EmailMessage;
  if (!Constructor)
    throw emailProviderError(
      "cloudflare-email",
      "NOT_CONFIGURED",
      "EmailMessage constructor is unavailable.",
    );
  return {
    name: "cloudflare-email",
    async send(message, context) {
      try {
        message = applyUnsubscribe(message, "cloudflare-email");
        validateAttachments("cloudflare-email", message);
        if (message.stream !== undefined || context.stream !== undefined) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email does not support stream selection.",
            ),
          };
        }
        const unsupportedOption = (
          ["tracking", "amp", "dsn", "preheader", "locale", "tags", "metadata"] as const
        ).find((option) => message[option] !== undefined);
        if (unsupportedOption) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              `Cloudflare Email does not support the ${unsupportedOption} option.`,
            ),
          };
        }
        if (context.signal?.aborted) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "CANCELLED",
              "Cloudflare Email send was cancelled.",
              { retryable: false },
            ),
          };
        }
        if (message.sandbox === true) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email does not support sandbox delivery.",
            ),
          };
        }
        rejectTransportOwnedHeaders(message.headers);
        if (message.scheduledAt !== undefined) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email does not support scheduled delivery.",
            ),
          };
        }
        if (message.raw !== undefined) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email does not support raw message payloads.",
            ),
          };
        }
        if (message.idempotencyKey !== undefined) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email does not support idempotency keys.",
            ),
          };
        }
        if (message.template !== undefined) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email does not support template payloads.",
            ),
          };
        }
        if (
          message.react !== undefined ||
          message.jsx !== undefined ||
          message.mjml !== undefined ||
          message.handlebars !== undefined ||
          message.handlebarsVars !== undefined ||
          message.liquid !== undefined ||
          message.liquidVars !== undefined
        ) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email does not support renderer payloads.",
            ),
          };
        }
        message = applyPersonalization("cloudflare-email", message);
        validateAddresses("cloudflare-email", message);
        const from = addresses(message.from)[0];
        const to = addresses(message.to);
        const recipients = [
          ...to,
          ...(message.cc ? addresses(message.cc) : []),
          ...(message.bcc ? addresses(message.bcc) : []),
        ];
        if (!from || to.length === 0)
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "INVALID_OPTIONS",
              "from and to are required.",
            ),
          };
        if (recipients.length > 1)
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "UNSUPPORTED",
              "Cloudflare Email supports exactly one envelope recipient per message.",
            ),
          };
        const customId = headerValue(message.headers, "message-id");
        if (customId !== undefined && !messageIdPattern.test(customId)) {
          return {
            data: null,
            error: emailProviderError(
              "cloudflare-email",
              "INVALID_OPTIONS",
              "Message-ID must use the <local@domain> form.",
            ),
          };
        }
        const id = customId ?? `<${crypto.randomUUID()}@vitehub.email>`;
        const raw = encodeCloudflareMimeMessage(message, id);
        await sendWithCancellation(
          options.binding,
          new Constructor(addressValue(from).email, addressValue(recipients[0]!).email, raw),
          context.signal,
        );
        return { data: { at: new Date(), driver: "cloudflare-email", id }, error: null };
      } catch (cause) {
        if (isEmailProviderError(cause)) return { data: null, error: cause };
        return {
          data: null,
          error: emailProviderError(
            "cloudflare-email",
            "PROVIDER",
            "Cloudflare Email send failed.",
            { cause },
          ),
        };
      }
    },
  };
}
