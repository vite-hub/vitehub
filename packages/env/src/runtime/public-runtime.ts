export async function useSafePublicRuntimeConfig(endpoint = "/_vitehub/env"): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`[vitehub] Failed to load public runtime config from ${endpoint}: ${response.status}`)
  }
  return await response.json() as Record<string, unknown>
}
