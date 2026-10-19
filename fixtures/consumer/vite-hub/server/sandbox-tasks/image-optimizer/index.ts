export interface SandboxTaskPayload {
  queued?: boolean
}

export default async function imageOptimizer(payload: SandboxTaskPayload = {}) {
  return { optimized: payload.queued === true }
}
