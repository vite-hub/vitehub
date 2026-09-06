export async function withExportDeadline<T>(timeoutMs: number, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('[vitehub] Telemetry delivery timed out.')) }, timeoutMs) })
  try { return await Promise.race([Promise.resolve().then(() => send(controller.signal)), timeout]) }
  finally { if (timer) clearTimeout(timer) }
}
