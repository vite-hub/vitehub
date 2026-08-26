type InvocationReader<T> = {
  get: (id: string) => Promise<T | undefined>
  getByRunId: (runId: string, agentName?: string) => Promise<T | undefined>
}

export function decodeInvocationRouteId(id: string) {
  return decodeURIComponent(id)
}

export async function resolveBabysitterInvocation<T>(invocations: InvocationReader<T>, id: string) {
  const direct = await invocations.get(id)
  if (direct || id.startsWith('sha256_')) return direct
  return invocations.getByRunId(id, 'babysitter')
}
