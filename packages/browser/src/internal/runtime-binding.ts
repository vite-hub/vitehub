export async function runtimeBinding(name: string): Promise<unknown> {
  // SAFETY: Runtime hosts install an optional binding map; values stay unknown and own properties are checked below.
  const environment = (globalThis as { __env__?: Record<string, unknown> }).__env__
  if (environment && Object.hasOwn(environment, name)) {
    const globalBinding = environment[name]
    if (globalBinding) return globalBinding
  }
  try {
    const workers = await import("cloudflare:workers") as { env?: Record<string, unknown> }
    return workers.env && Object.hasOwn(workers.env, name) ? workers.env[name] : undefined
  }
  catch {
    return
  }
}
