import { checkRateLimit, checkRateLimit as check } from "vite-hub/rate-limit"

export async function imported(event) {
  const [checkRateLimitError, decision] = await checkRateLimit(event, "search", { limit: 30, window: "1m" })
  if (checkRateLimitError) throw checkRateLimitError
  return decision.allowed
}

export async function parameter(checkRateLimit) {
  const decision = await checkRateLimit()
  return decision
}

export async function local() {
  const checkRateLimit = async () => true
  const decision = await checkRateLimit()
  return decision
}

export async function declaration() {
  const decision = await checkRateLimit()
  async function checkRateLimit() { return true }
  return decision
}

export async function caught() {
  try { throw async () => true }
  catch (checkRateLimit) {
    const decision = await checkRateLimit()
    return decision
  }
}

export async function hoisted() {
  const decision = await checkRateLimit()
  if (false) { var checkRateLimit = async () => true }
  return decision
}

export async function aliased(event) {
  const [checkRateLimitError2, decision] = await check(event, "search", { limit: 30, window: "1m" })
  if (checkRateLimitError2) throw checkRateLimitError2
  return decision.allowed
}

export async function destructured({ check }) {
  const decision = await check()
  return decision
}
