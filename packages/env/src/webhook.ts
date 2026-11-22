import { githubHmacSignatureFormat, verifyViteHubHmacSignature, verifyViteHubStripeSignature, viteHubHmacSha256 } from "@vite-hub/internal/secret"
import { defineErrors } from "@vite-hub/runtime"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { runtimeEnv, standardSource } from "./internal/runtime-env.ts"

import type { Result } from "@vite-hub/runtime"
import type { RequestEvent } from "./internal/runtime-env.ts"
import type { StandardSchemaV1 } from "./schema.ts"

const webhookErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/env/diagnostics",
  codes: {
    // Runtime errors.
    ENV_WEBHOOK_BODY_INVALID: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_webhook_body_invalid",
      why: "The webhook has a valid signature, but its body is not JSON, or a GitHub form delivery has no JSON `payload` field.",
      fix: "Set the provider to send JSON. GitHub can send `application/json` or `application/x-www-form-urlencoded`, and `verifyWebhook()` reads both.",
    },
    ENV_WEBHOOK_SCHEMA_MISMATCH: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_webhook_schema_mismatch",
      why: "The webhook has a valid signature and a JSON body, but the body does not match `schema`.",
      fix: "Read `error.cause` for the schema issues. Check that the provider sends the event that the route expects, and change `schema` when the provider changed the shape of its events.",
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
export type WebhookErrorCode = "ENV_WEBHOOK_BODY_INVALID" | "ENV_WEBHOOK_SCHEMA_MISMATCH" | "ENV_WEBHOOK_SECRET_UNSET" | "ENV_WEBHOOK_SIGNATURE_INVALID"

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

/** `VerifyWebhookOptions` with a Standard Schema, such as a Valibot or Zod schema, that checks the body. */
export type VerifyWebhookSchemaOptions<TBody> = VerifyWebhookOptions & {
  /** Checks the parsed body. `verifyWebhook()` returns its output, or `ENV_WEBHOOK_SCHEMA_MISMATCH`. */
  schema: StandardSchemaV1<TBody>
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

function webhookJson(options: VerifyWebhookOptions, headers: Headers, text: string): string | null {
  if (options.provider !== "github" || !headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return text
  return new URLSearchParams(text).get("payload")
}

/**
 * Checks the signature of a webhook that Stripe, GitHub, or another provider sends to a route, and returns
 * `[error, body]` with the parsed JSON body. For a GitHub delivery with the form content type, `body` is the JSON
 * of its `payload` field. Pass `schema` to check the body and type it; without it, `body` is `unknown`.
 * It reads the raw body once, so do not read the body before you call it.
 * It reads the secret from the server variable `secret` on each request. The variable holds one secret, or a
 * comma-separated list while you rotate. It compares in constant time and runs on every host.
 *
 * ```ts [server/api/stripe/webhook.post.ts]
 * import { defineEventHandler, HTTPError } from "h3"
 * import * as v from "valibot"
 * import { verifyWebhook } from "vite-hub/env"
 *
 * export default defineEventHandler(async (event) => {
 *   const schema = v.object({ type: v.string() })
 *   const [error, stripeEvent] = await verifyWebhook(event, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", schema })
 *   if (error) throw new HTTPError({ status: 400, message: error.message })
 *   return { received: stripeEvent.type }
 * })
 * ```
 */
export function verifyWebhook<TBody>(event: RequestEvent, options: VerifyWebhookSchemaOptions<TBody>): Promise<Result<TBody, WebhookErrorCode>>
export function verifyWebhook(event: RequestEvent, options: VerifyWebhookOptions): Promise<Result<unknown, WebhookErrorCode>>
export async function verifyWebhook(event: RequestEvent, options: VerifyWebhookOptions & { schema?: StandardSchemaV1 }): Promise<Result<unknown, WebhookErrorCode>> {
  const source = standardSource(event)
  const name = options.secret
  const secrets = readSecrets(runtimeEnv(source)[name])
  if (!secrets.length) return [webhookErrors.ENV_WEBHOOK_SECRET_UNSET({ name }), undefined]
  const request = getStandardContext(source).req
  const headerName = signatureHeader(options)
  const header = request.headers.get(headerName)
  if (!header) return [webhookErrors.ENV_WEBHOOK_SIGNATURE_INVALID({ header: headerName, name }), undefined]
  const body = new Uint8Array(await request.arrayBuffer())
  let valid = false
  for (const secret of secrets) valid = await verifySignature(options, secret, header, body) || valid
  if (!valid) return [webhookErrors.ENV_WEBHOOK_SIGNATURE_INVALID({ header: headerName, name }), undefined]
  const json = webhookJson(options, request.headers, new TextDecoder().decode(body))
  if (json === null) return [webhookErrors.ENV_WEBHOOK_BODY_INVALID(), undefined]
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  }
  catch (cause) {
    return [webhookErrors.ENV_WEBHOOK_BODY_INVALID({ cause }), undefined]
  }
  if (!options.schema) return [undefined, parsed]
  const result = await options.schema["~standard"].validate(parsed)
  if (result.issues) return [webhookErrors.ENV_WEBHOOK_SCHEMA_MISMATCH({ cause: result.issues }), undefined]
  return [undefined, result.value]
}

/** How `signWebhook()` signs an outgoing body. */
export interface SignWebhookOptions {
  /** `"github"` sets `x-hub-signature-256`. `"stripe"` sets `stripe-signature` with the time. */
  provider: "github" | "stripe"
  /** The signing secret itself, not the name of a variable. The receiver must have the same secret. */
  secret: string
  /** The signed time for `"stripe"`, in Unix seconds. Default: now. */
  timestamp?: number
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Signs the raw body of an outgoing webhook with HMAC-SHA256 and returns the headers to send with it. The receiver
 * checks them with `verifyWebhook()` or the provider's own SDK. Send the exact `body` that you signed. It uses Web
 * Crypto only, so it runs on every host.
 *
 * ```ts
 * import { signWebhook } from "vite-hub/env"
 *
 * const body = JSON.stringify({ type: "deploy.finished" })
 * const headers = await signWebhook(body, { provider: "github", secret: process.env.HOOK_SECRET! })
 * await fetch("https://example.com/hook", { method: "POST", body, headers: { ...headers, "content-type": "application/json" } })
 * ```
 */
export async function signWebhook(body: string | Uint8Array<ArrayBuffer>, options: SignWebhookOptions): Promise<Record<string, string>> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  if (options.provider === "github") {
    return { "x-hub-signature-256": `sha256=${toHex(await viteHubHmacSha256(options.secret, bytes))}` }
  }
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
  const prefix = new TextEncoder().encode(`${timestamp}.`)
  const payload = new Uint8Array(prefix.length + bytes.length)
  payload.set(prefix)
  payload.set(bytes, prefix.length)
  return { "stripe-signature": `t=${timestamp},v1=${toHex(await viteHubHmacSha256(options.secret, payload))}` }
}
