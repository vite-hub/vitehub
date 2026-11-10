import { formsDiagnostics } from "./errors.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { DefineFormOptions, FormDefinition } from "./types.ts"

const windowPattern = /^\d+(?:ms|s|m|h|d)$/
const fieldPattern = /^[A-Za-z_][\w-]*$/

function invalid(message: string): Error {
  return formsDiagnostics.FORMS_C0001({ message: `[vitehub] defineForm(): ${message}` })
}

/**
 * A form that visitors fill in and the site owner reads: contact, feedback, "report a problem". The server checks the
 * origin, the size, a honeypot field, and a rate limit, then validates the body with `schema`, stores it, and sends
 * the notifications. Put it in `server/forms/<name>.ts` as the default export.
 */
export function defineForm<const TSchema extends StandardSchemaV1>(options: DefineFormOptions<TSchema>): FormDefinition<TSchema> {
  const standard: unknown = options?.schema?.["~standard"]
  if (!standard || typeof standard !== "object" || typeof Reflect.get(standard, "validate") !== "function") {
    throw invalid("`schema` must be a Standard Schema, such as a Valibot or Zod object schema.")
  }
  const { rateLimit, honeypot, maxBytes, notify } = options
  if (rateLimit !== undefined && rateLimit !== false) {
    if (!Number.isInteger(rateLimit.limit) || rateLimit.limit < 1) throw invalid("`rateLimit.limit` must be a whole number of 1 or more.")
    if (!windowPattern.test(rateLimit.window)) throw invalid("`rateLimit.window` must be a duration such as `30s`, `1m`, or `1h`.")
  }
  if (honeypot !== undefined && honeypot !== false && !fieldPattern.test(honeypot)) throw invalid("`honeypot` must be a field name, such as `website`.")
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1024)) throw invalid("`maxBytes` must be a whole number of 1024 or more.")
  for (const origin of options.origins ?? []) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) throw invalid(`\`origins\` must hold origins such as \`https://example.com\`, not ${JSON.stringify(origin)}.`)
  }
  if (notify?.email) {
    const to = typeof notify.email.to === "string" ? [notify.email.to] : notify.email.to
    if (!to.length || to.some(address => !address.includes("@"))) throw invalid("`notify.email.to` must hold one or more email addresses.")
  }
  if (options.store === false && !notify?.email && !options.onSubmit) {
    throw invalid("With `store: false`, set `notify` or `onSubmit`, or the submissions go nowhere.")
  }
  return { "~form": true, options }
}

export function isFormDefinition(value: unknown): value is FormDefinition {
  return Boolean(value) && typeof value === "object" && Reflect.get(value as object, "~form") === true
}
