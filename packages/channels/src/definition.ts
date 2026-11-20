import { parseDuration } from "@vite-hub/runtime"

import type { Duration } from "@vite-hub/runtime"
import type { ChannelAdapter, ChannelDefinition, ChannelDefinitionOptions } from "./types.ts"
import { channelDefinitionBrand } from "./brand.ts"
import { channelsErrorDiagnostics } from "./error-diagnostics.ts"

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Whether `value` came from `defineChannel()`. */
export function isChannelDefinition(value: unknown): value is ChannelDefinition {
  return isObject(value) && value[channelDefinitionBrand] === true
}

/** Whether the adapter receives webhooks from an HTTP sender, such as `webhook()` or `stripe()`. */
export function isWebhookChannelAdapter(adapter: unknown): adapter is ChannelAdapter & { webhook: Record<string, unknown> } {
  return isObject(adapter) && isObject(adapter.webhook)
}

const verifyHint = "Use `webhook({ signature, secret })`, such as `webhook({ signature: 'bearer', secret: 'HOOKS_SECRET' })`. To accept requests that anyone can send, use `webhook({ secret: false })`."

const variableName = /^[A-Z_][A-Z0-9_]*$/i

const signatureNames = new Set(["bearer", "token", "github", "stripe"])

const renamedSignatures: Record<string, string> = { "github-sha256": "github", "stripe-sha256": "stripe" }

function signatureProblem(signature: unknown): [problem: string, fix: string] | undefined {
  if (typeof signature === "string") {
    if (signatureNames.has(signature)) return
    const renamed = renamedSignatures[signature]
    return renamed
      ? [`uses \`signature: '${signature}'\`, which is now \`'${renamed}'\``, `Set \`signature: '${renamed}'\`.`]
      : [`has an unknown \`signature\``, "Set `signature` to `'bearer'`, `'token'`, `'github'`, `'stripe'`, `{ type: 'hmac-sha256' }`, `{ type: 'stripe', tolerance }`, or `{ verify }`."]
  }
  if (!isObject(signature)) return [`has an unknown \`signature\``, "Set `signature` to `'bearer'`, `'token'`, `'github'`, `'stripe'`, `{ type: 'hmac-sha256' }`, `{ type: 'stripe', tolerance }`, or `{ verify }`."]
  if (typeof signature.verify === "function") return
  if ("preset" in signature) {
    const type = signature.preset === "stripe-sha256" ? "stripe" : String(signature.preset)
    return [`sets \`signature: { preset }\`, which is now \`signature: { type }\``, `Set \`signature: { type: '${type}' }\`${"toleranceSeconds" in signature ? " and `tolerance`, such as `tolerance: '5m'`" : ""}.`]
  }
  if (signature.type === "hmac-sha256") return
  if (signature.type !== "stripe") return [`has an unknown \`signature.type\``, "Set `type: 'hmac-sha256'` or `type: 'stripe'`."]
  if ("toleranceSeconds" in signature) return ["sets `toleranceSeconds`, which is now `tolerance`", "Set `tolerance` to a duration, such as `tolerance: '5m'`."]
  if (signature.tolerance === undefined) return
  try {
    parseDuration(signature.tolerance as Duration, "tolerance")
  }
  catch {
    return ["sets a `tolerance` that is not a duration", "Set `tolerance` to a duration, such as `tolerance: '5m'` or `tolerance: '30s'`."]
  }
}

function validateWebhookVerification(kind: string, webhook: Record<string, unknown>): void {
  const { header, secret, signature } = webhook
  const fail = (problem: string, fix = verifyHint) => {
    throw channelsErrorDiagnostics.CHANNELS_C0011({ message: `The "${kind}" webhook adapter ${problem}. ${fix}` })
  }
  if (secret === false) {
    if (signature !== undefined) fail("sets `secret: false` and a `signature`, so it does not verify requests", "Remove `signature` to accept unsigned requests, or set a `secret`.")
    return
  }
  if (signature === undefined && secret === undefined) fail("has no `signature` and no `secret`, so anyone can send it events")
  if (signature === undefined) fail("has a `secret` but no `signature`, so it cannot verify requests")
  if (secret === undefined) fail("has a `signature` but no `secret`, so it cannot verify requests")
  if (typeof secret === "string" && !variableName.test(secret)) {
    fail("has a `secret` string that is not a server variable name", "Set `secret` to the name of the server variable that holds the secret, such as `secret: 'PREFECT_WEBHOOK_SECRET'`, or to a function that returns it, such as `secret: () => useServerEnv().prefect.webhookSecret`.")
  }
  const problem = signatureProblem(signature)
  if (problem) fail(...problem)
  if (signature === "token" && (typeof header !== "string" || !header.trim())) {
    fail("uses `signature: 'token'`, which needs a `header`", "Set `header` to the header that carries the secret, such as `header: 'x-gitlab-token'`.")
  }
}

export function validateChannelDefinition(value: unknown): asserts value is ChannelDefinitionOptions {
  if (!isObject(value)) {
    throw channelsErrorDiagnostics.CHANNELS_C0001({ message: "`defineChannel()` expects an object with an `adapter`." })
  }
  const adapter = value.adapter
  if (!isObject(adapter) || typeof adapter.kind !== "string" || !adapter.kind.trim()) {
    throw channelsErrorDiagnostics.CHANNELS_C0007({ message: "`defineChannel()` needs an `adapter` with a non-empty `kind`, such as `stripe()` or `webhook()` from `vite-hub/channels`, `slack()` from `vite-hub/agent/channels`, or `{ kind, send }`." })
  }
  if (adapter.send !== undefined && typeof adapter.send !== "function") {
    throw channelsErrorDiagnostics.CHANNELS_C0008({ message: `The "${adapter.kind}" adapter \`send\` must be a function.` })
  }
  if (isWebhookChannelAdapter(adapter)) validateWebhookVerification(adapter.kind, adapter.webhook)
  if (value.on === undefined) return
  if (!isObject(value.on)) {
    throw channelsErrorDiagnostics.CHANNELS_C0009({ message: "`defineChannel({ on })` expects an object of targets by event name." })
  }
  for (const [name, target] of Object.entries(value.on)) {
    if (!name.trim()) {
      throw channelsErrorDiagnostics.CHANNELS_C0009({ message: "`defineChannel({ on })` event names must be non-empty." })
    }
    if (typeof target === "function") {
      if (!isWebhookChannelAdapter(adapter)) {
        throw channelsErrorDiagnostics.CHANNELS_C0010({ message: `The \`on\` handler "${name}" needs an adapter that receives webhooks, such as \`webhook()\` or \`stripe()\`. The "${adapter.kind}" adapter sends its messages to the Agent that lists the Channel. Use \`defineChannelTrigger()\` for a custom trigger.` })
      }
      continue
    }
    if (!isObject(target) || typeof target.invoke !== "function") {
      throw channelsErrorDiagnostics.CHANNELS_C0009({ message: `The \`on\` target "${name}" must be a function or a trigger from \`defineChannelTrigger()\`.` })
    }
  }
}

/**
 * Defines a Channel: one connection to a platform, in both directions. Put it in `server/channels/<name>.ts`.
 * Inbound events go to the targets in `on`, or to the Agent that lists the Channel. `useChannel(name).send()` sends
 * through the adapter.
 *
 * @example
 * export default defineChannel({
 *   adapter: stripe(),
 *   on: { 'checkout.session.completed': event => sendQueue('fulfil', event.data) },
 * })
 */
export function defineChannel<TAdapter extends ChannelAdapter<never, never>>(
  definition: ChannelDefinitionOptions<TAdapter>,
): ChannelDefinition<TAdapter> {
  validateChannelDefinition(definition)
  return Object.defineProperty({ ...definition }, channelDefinitionBrand, { value: true }) as ChannelDefinition<TAdapter>
}
