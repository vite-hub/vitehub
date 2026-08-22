export interface SandboxPayload {
  queued?: boolean
}

export default async function imageOptimizer(payload: SandboxPayload = {}) {
  return { optimized: payload.queued === true }
}
