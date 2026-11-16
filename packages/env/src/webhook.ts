import { githubHmacSignatureFormat, verifyViteHubHmacSignature, verifyViteHubStripeSignature } from "@vite-hub/internal/secret"
import { defineErrors } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { runtimeEnv, standardSource } from "./internal/runtime-env.ts"

import type { Result } from "@vite-hub/runtime"
import type { RequestEvent } from "./internal/runtime-env.ts"

const webhookErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/env/diagnostics",
  codes: {
    // Runtime errors. `verifyWebhook()` returns them as `[error, undefined]`.
    ENV_WEBHOOK_BODY_INVALID: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_webhook_body_invalid",
      why: "The webhook has a valid signature, but its body is not JSON.",
      fix: "Set the provider to send JSON. In GitHub webhook settings, set Content type to `application/json`.",
    },
    ENV_WEBHOOK_SECRET_UNSET: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_webhook_secret_unset",
      why: ({ name }: { name: string }) => `\`${name}\` has no webhook secret on this server, so every delivery is refused.`,
      fix: "Set the variable to the signing secret that the provider shows for this endpoint, such as Stripe's `whsec_...` value: in `.env` for `vite dev`, and as a secret on the host for production. To rotate, set the old and the new secret separated by a comma, then remove the old one.",
    },
    ENV_WEBHOOK_SIGNATURE_INVALID: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_webhook_signature_invalid",
      why: ({ header, name }: { header: string, name: string }) => `The \`${header}\` header is missing, or it does not match the body signed with a secret in \`${name}\`.`,
      fix: "Set the variable to the signing secret of this endpoint, and do not change the body before `verifyWebhook()` reads it. A Stripe signature also fails when it is older than `toleranceSeconds` (default 300), so check the server clock. Answer with `400`, so the provider shows the failed delivery and sends it again.",
    },
  },
})

/** The codes that `verifyWebhook()` returns. */
export type WebhookErrorCode = "ENV_WEBHOOK_BODY_INVALID" | "ENV_WEBHOOK_SECRET_UNSET" | "ENV_WEBHOOK_SIGNATURE_INVALID"

/** How `verifyWebhook()` checks the signature. `secret` is the name of the server variable that holds the signing secret. */
export type VerifyWebhookOptions =
  | {
    /** `Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>">`. */
    provider: "stripe"
    /** The name of the server variable with the endpoint's signing secret (`whsec_...`), such as `"STRIPE_WEBHOOK_SECRET"`. */
    secret: string
    /** How old the signed time can be, in seconds. Default: `300`, as in Stripe's SDKs. */
    toleranceSeconds?: number
  }
  | {
    /** `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body>`. */
    provider: "github"
    /** The name of the server variable with the webhook secret, such as `"GITHUB_WEBHOOK_SECRET"`. */
    secret: string
  }
  | {
    /** `header` carries `prefix` followed by the HMAC-SHA256 of the body. */
    provider: "hmac"
    /** The name of the server variable with the signing key, such as `"AIRTABLE_WEBHOOK_SECRET"`. */
    secret: string
    /** The header that carries the signature, such as `"x-airtable-content-mac"`. */
    header: string
    /** The text before the digest, such as `"hmac-sha256="`. Default: none. */
    prefix?: string
    /** The digest encoding in the header. Default: `"hex"`, compared without case. */
    encoding?: "hex" | "base64"
    /** How the variable encodes the key. `"base64"` decodes it first. Default: `"utf8"`. */
    secretEncoding?: "utf8" | "base64"
  }

function readSecrets(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map(secret => secret.trim()).filter(Boolean) : []
}

function signatureHeader(options: VerifyWebhookOptions): string {
  if (options.provider === "stripe") return "stripe-signature"
  if (options.provider === "github") return "x-hub-signature-256"
  return options.header.toLowerCase()
}

function verifySignature(options: VerifyWebhookOptions, secret: string, header: string, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (options.provider === "stripe") return verifyViteHubStripeSignature(secret, header, body, { toleranceSeconds: options.toleranceSeconds })
  if (options.provider === "github") return verifyViteHubHmacSignature(secret, header, body, githubHmacSignatureFormat)
  return verifyViteHubHmacSignature(secret, header, body, options)
}

/**
 * Checks the signature of a webhook that Stripe, GitHub, or another provider sends to a route, and returns
 * `[error, body]` with the parsed JSON body. It reads the raw body once, so do not read the body before you call it.
 * It reads the secret from the server variable `secret` on each request. The variable holds one secret, or a
 * comma-separated list while you rotate. It compares in constant time and runs on every host.
 *
 * ```ts [server/api/stripe/webhook.post.ts]
 * import { defineEventHandler, HTTPError } from "h3"
 * import { verifyWebhook } from "vite-hub/env"
 *
 * export default defineEventHandler(async (event) => {
 *   const [error, stripeEvent] = await verifyWebhook<{ type: string }>(event, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" })
 *   if (error) throw new HTTPError({ status: 400, message: error.message })
 *   return { received: stripeEvent.type }
 * })
 * ```
 */
export async function verifyWebhook<TBody = unknown>(event: RequestEvent, options: VerifyWebhookOptions): Promise<Result<TBody, WebhookErrorCode>> {
  const source = standardSource(event)
  const name = options.secret
  const secrets = readSecrets(runtimeEnv(source)[name])
  if (!secrets.length) return [webhookErrors.ENV_WEBHOOK_SECRET_UNSET({ name }), undefined]
  const request = getStandardContext(source).req
  const headerName = signatureHeader(options)
  const header = request.headers.get(headerName)
  if (!header) return [webhookErrors.ENV_WEBHOOK_SIGNATURE_INVALID({ header: headerName, name }), undefined]
  const body = new Uint8Array(await request.arrayBuffer())
  // Check every secret, so the time does not show which secret matched.
  let valid = false
  for (const secret of secrets) valid = await verifySignature(options, secret, header, body) || valid
  if (!valid) return [webhookErrors.ENV_WEBHOOK_SIGNATURE_INVALID({ header: headerName, name }), undefined]
  try {
    return [undefined, JSON.parse(new TextDecoder().decode(body)) as TBody]
  }
  catch (cause) {
    return [webhookErrors.ENV_WEBHOOK_BODY_INVALID({ cause }), undefined]
  }
}
