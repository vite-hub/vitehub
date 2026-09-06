/** Bound host shutdown and give transports a signal to release their resources. */
export async function withExportDeadline<T>(timeoutMs: number, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("[vitehub] Telemetry delivery timed out.")
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try { return await Promise.race([Promise.resolve().then(() => send(controller.signal)), timeout]) }
  finally { clearTimeout(timer!) }
}
