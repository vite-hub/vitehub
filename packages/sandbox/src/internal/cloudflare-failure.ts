/** Waits before each retry of a Cloudflare Sandbox request or Sandbox Task run. */
export const cloudflareRetryDelays = [1_000, 2_000, 5_000, 10_000, 15_000]
const notStartedMessage = /container is starting|currently provisioning|retry in a moment|not listening in the tcp address|maximum number of running container instances exceeded|there is no container instance that can be provided to this durable object/i
const transientMessage = /network connection lost|durable object reset|code was updated|aborterror|aborted/i

/** What a failed Cloudflare Sandbox request proves about running it again. */
export interface CloudflareFailure {
  /** The Container was not ready, so the request never reached a process. */
  coldStart: boolean
  message: string
  overloaded: boolean
  retryable: boolean | undefined
  /** The request reached its ViteHub deadline (`SANDBOX_R0090`). The Container may still run it. */
  timedOut: boolean
  /** The message names a lost connection or a reset. Used only when the host sets no flag. */
  transient: boolean
}

/** Reads the Durable Object flags and the message from an error and its causes. */
export function readCloudflareFailure(error: unknown): CloudflareFailure {
  const chain = causeChain(error)
  const message = chain.map((value, index) => value instanceof Error ? value.message : index === 0 ? String(value) : "").filter(Boolean).join("\n")
  return {
    coldStart: notStartedMessage.test(message),
    message,
    overloaded: chain.some(value => errorFlag(value, "overloaded") === true),
    retryable: chain.map(value => errorFlag(value, "retryable")).find(value => value !== undefined),
    timedOut: chain.some(value => errorProperty(value, "code") === "SANDBOX_R0090"),
    transient: transientMessage.test(message),
  }
}

/**
 * Decides one retry. `idempotent` is true when a second call after a lost response has no other effect than the first.
 * A request that may have started a command is not idempotent: it retries only on a cold start.
 */
export function canRetryCloudflareRequest(failure: CloudflareFailure, idempotent: boolean) {
  // Cloudflare: an overloaded Durable Object must not receive more requests.
  if (failure.overloaded) return false
  if (failure.retryable === false) return false
  // provider-message-match: Cloudflare has no flag for a Container that is not ready. The request never reached a process, so even a command can retry.
  if (failure.coldStart) return true
  // A lost response can follow a started command, so only an idempotent request can retry.
  if (!idempotent) return false
  if (failure.retryable !== undefined) return failure.retryable
  // provider-message-match: Sandbox SDK errors can reach the Worker without a retryable flag.
  return failure.transient
}

function causeChain(error: unknown) {
  const chain: unknown[] = []
  for (let value = error; value !== undefined && value !== null && !chain.includes(value) && chain.length < 4; value = errorProperty(value, "cause"))
    chain.push(value)
  return chain
}

function errorFlag(error: unknown, name: "overloaded" | "retryable") {
  const value = errorProperty(error, name)
  return typeof value === "boolean" ? value : undefined
}

function errorProperty(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null && name in error ? Reflect.get(error, name) : undefined
}
