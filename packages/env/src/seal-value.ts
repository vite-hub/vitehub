import { viteHubSecretMinimumLength } from "@vite-hub/internal/secret"
import { defineErrors } from "@vite-hub/runtime"

import { SecretEnv } from "./secret.ts"
import { deriveSecret } from "./server.ts"

import type { Result, ViteHubContext } from "@vite-hub/runtime"
import type { StandardSchemaV1 } from "./schema.ts"
import type { SealKey } from "./seal.ts"

// Keep published codes stable. Explicit URLs also support runtimes that use anchor links.
const sealErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/env/diagnostics",
  codes: {
    // Runtime errors. `unseal()` returns them as `[error, undefined]`.
    ENV_SEAL_EXPIRED: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_expired",
      why: ({ expiresAt }: { expiresAt: number }) => `The sealed value expired at ${new Date(expiresAt).toISOString()}.`,
      fix: "Seal a new value. Give `seal()` a longer `ttl` when the value must live longer.",
    },
    ENV_SEAL_INVALID: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_invalid",
      why: "The string is not a sealed value, someone changed it, or another root secret sealed it.",
      fix: "Treat the string as untrusted and seal a new value. After a rotation of `VITEHUB_SECRET`, values sealed with the old secret do not open.",
    },
    ENV_SEAL_SCHEMA_MISMATCH: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_schema_mismatch",
      why: "The sealed value opened, but it does not match `schema`.",
      fix: "Read `error.cause` for the schema issues. A value sealed by an older deployment can have an older shape: seal a new value.",
    },
    ENV_SEAL_WRONG_PURPOSE: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_wrong_purpose",
      why: ({ purpose }: { purpose: string }) => `The value was sealed for another purpose than "${purpose}".`,
      fix: "Pass the purpose that `seal()` used. Each purpose has its own key, so a value cannot pass as a value of another purpose.",
    },

    // Config errors. `seal()` and `unseal()` throw them because the code must change.
    ENV_SEAL_ARGUMENT_INVALID: {
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_argument_invalid",
      why: ({ problem }: { problem: string }) => problem,
      fix: "Pass a purpose such as \"my-app:upload\", a JSON value, a `ttl` in seconds, and a `secret` of at least 32 characters.",
    },
  },
})

/** The codes that `unseal()` returns. */
export type UnsealErrorCode = "ENV_SEAL_EXPIRED" | "ENV_SEAL_INVALID" | "ENV_SEAL_SCHEMA_MISMATCH" | "ENV_SEAL_WRONG_PURPOSE"

export interface UnsealOptions {
  /** The request, so that on Cloudflare the root secret comes from its bindings. Without it, the active request's bindings. */
  event?: ViteHubContext
  /**
   * A root secret to use instead of `VITEHUB_SECRET`, of at least 32 characters. Use one for values that you store,
   * so that a rotation of `VITEHUB_SECRET` does not make them unreadable.
   */
  secret?: string | SecretEnv<string>
}

export interface UnsealSchemaOptions<T> extends UnsealOptions {
  /** A Standard Schema, such as a Valibot or Zod schema. `unseal()` returns its output. */
  schema: StandardSchemaV1<T>
}

export interface SealOptions extends UnsealOptions {
  /** Seconds until `unseal()` returns `ENV_SEAL_EXPIRED`. Without it, the value does not expire. */
  ttl?: number
}

/** Derives the key of a purpose. The generated `#vitehub/env/server` module passes one that also reads the development secret. */
export type SealSecretDerivation = (purpose: string, event: ViteHubContext | undefined, root: string | undefined) => Promise<string>

/** `seal()` and `unseal()` on one key derivation. */
export interface Sealing {
  seal: (purpose: string, value: unknown, options?: SealOptions) => Promise<string>
  unseal: (purpose: string, sealed: string, options?: UnsealOptions & { schema?: StandardSchemaV1 }) => Promise<Result<unknown, UnsealErrorCode>>
}

const version = 1
// version (1 byte) + purpose fingerprint (4) + expiry in Unix milliseconds, 0 for none (8)
const headerLength = 13
const ivLength = 12
const tagLength = 16
const encoder = new TextEncoder()

function argumentError(problem: string): never {
  throw sealErrors.ENV_SEAL_ARGUMENT_INVALID({ problem })
}

function checkPurpose(purpose: unknown): asserts purpose is string {
  if (typeof purpose !== "string" || !purpose) argumentError("`purpose` must be a non-empty string.")
}

// Validate the input before JSON.stringify can omit members or change them to null.
function checkJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    argumentError("`value` must contain only JSON values and no cycles.")
  }
  const array = Array.isArray(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if ((!array && prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) {
    argumentError("`value` must contain only plain JSON objects and arrays.")
  }
  ancestors.add(value)
  if (array) {
    if (Object.keys(value).length !== value.length) argumentError("`value` must not contain sparse arrays or extra array properties.")
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) argumentError("`value` must not contain sparse arrays.")
      checkJsonValue(value[index], ancestors)
    }
  }
  else {
    for (const member of Object.values(value)) checkJsonValue(member, ancestors)
  }
  ancestors.delete(value)
}

function rootSecret(secret: UnsealOptions["secret"]): string | undefined {
  if (secret === undefined) return undefined
  const value = secret instanceof SecretEnv ? secret.unseal() : secret
  if (typeof value !== "string" || value.length < viteHubSecretMinimumLength) {
    argumentError(`\`secret\` must be a string of at least ${viteHubSecretMinimumLength} characters.`)
  }
  return value
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[\w-]+$/.test(text)) return undefined
  try {
    return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0))
  }
  catch {
    return undefined
  }
}

async function fingerprint(purpose: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(purpose))).slice(0, 4)
}

async function purposeKey(derive: SealSecretDerivation, purpose: string, options: UnsealOptions, usage: "decrypt" | "encrypt"): Promise<SealKey> {
  const hex = await derive(`vitehub:seal:${purpose}`, options.event, rootSecret(options.secret))
  const raw = Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16))
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage])
}

/** Builds `seal()` and `unseal()` on a key derivation. The generated `#vitehub/env/server` module uses it. */
export function createSealing(derive: SealSecretDerivation): Sealing {
  return {
    async seal(purpose, value, options = {}) {
      checkPurpose(purpose)
      const { ttl } = options
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0)) {
        argumentError("`ttl` must be a positive number of seconds.")
      }
      checkJsonValue(value)
      let json: string | undefined
      try {
        json = JSON.stringify(value)
      }
      catch (cause) {
        argumentError(`\`value\` cannot be serialized as JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      if (json === undefined) argumentError("`value` must be a JSON value, not undefined or a function.")

      const header = new Uint8Array(headerLength)
      header[0] = version
      header.set(await fingerprint(purpose), 1)
      new DataView(header.buffer).setFloat64(5, ttl === undefined ? 0 : Date.now() + ttl * 1000)
      const iv = crypto.getRandomValues(new Uint8Array(ivLength))
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: header },
        await purposeKey(derive, purpose, options, "encrypt"),
        encoder.encode(json),
      ))
      const sealed = new Uint8Array(headerLength + ivLength + ciphertext.length)
      sealed.set(header)
      sealed.set(iv, headerLength)
      sealed.set(ciphertext, headerLength + ivLength)
      return toBase64Url(sealed)
    },

    async unseal(purpose, sealed, options = {}) {
      checkPurpose(purpose)
      // Derive first, so that a missing root secret throws for every input.
      const key = await purposeKey(derive, purpose, options, "decrypt")
      const bytes = typeof sealed === "string" ? fromBase64Url(sealed) : undefined
      if (!bytes || bytes.length < headerLength + ivLength + tagLength || bytes[0] !== version) {
        return [sealErrors.ENV_SEAL_INVALID(), undefined]
      }
      const header = bytes.subarray(0, headerLength)
      const expected = await fingerprint(purpose)
      if (expected.some((byte, index) => header[1 + index] !== byte)) {
        return [sealErrors.ENV_SEAL_WRONG_PURPOSE({ purpose }), undefined]
      }
      let plaintext: ArrayBuffer
      try {
        plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.subarray(headerLength, headerLength + ivLength), additionalData: header },
          key,
          bytes.subarray(headerLength + ivLength),
        )
      }
      catch {
        return [sealErrors.ENV_SEAL_INVALID(), undefined]
      }
      // Check the expiry after decryption, so that a changed expiry reads as ENV_SEAL_INVALID.
      const expiresAt = new DataView(header.buffer, header.byteOffset).getFloat64(5)
      if (expiresAt !== 0 && Date.now() >= expiresAt) return [sealErrors.ENV_SEAL_EXPIRED({ expiresAt }), undefined]
      const value: unknown = JSON.parse(new TextDecoder().decode(plaintext))
      if (!options.schema) return [undefined, value]
      const result = await options.schema["~standard"].validate(value)
      if (result.issues) return [sealErrors.ENV_SEAL_SCHEMA_MISMATCH({ cause: result.issues }), undefined]
      return [undefined, result.value]
    },
  }
}

const sealing = createSealing((purpose, event, root) => deriveSecret(purpose, { event, root }))

/**
 * Encrypts and signs a JSON value for one purpose, with a key that ViteHub derives from `VITEHUB_SECRET`.
 * Returns a URL-safe string that only `unseal()` with the same purpose can read.
 * Throws `ENV_REQUIRED_MISSING` when no root secret is set, and `ENV_SEAL_ARGUMENT_INVALID` for a bad argument.
 *
 * @example
 * const ticket = await seal("my-app:upload", { userId }, { ttl: 900 })
 */
export function seal(purpose: string, value: unknown, options?: SealOptions): Promise<string> {
  return sealing.seal(purpose, value, options)
}

/**
 * Reads a value from `seal()`. Returns `[error, undefined]` with `ENV_SEAL_EXPIRED`, `ENV_SEAL_INVALID`,
 * `ENV_SEAL_SCHEMA_MISMATCH`, or `ENV_SEAL_WRONG_PURPOSE`, else `[undefined, value]`. Pass `schema` to check the value
 * and type it. Throws when no root secret is set.
 *
 * @example
 * const [error, upload] = await unseal("my-app:upload", ticket, { schema: v.object({ userId: v.string() }) })
 */
export function unseal<T>(purpose: string, sealed: string, options: UnsealSchemaOptions<T>): Promise<Result<T, UnsealErrorCode>>
export function unseal(purpose: string, sealed: string, options?: UnsealOptions): Promise<Result<unknown, UnsealErrorCode>>
export function unseal(purpose: string, sealed: string, options?: UnsealOptions & { schema?: StandardSchemaV1 }): Promise<Result<unknown, UnsealErrorCode>> {
  return sealing.unseal(purpose, sealed, options)
}
