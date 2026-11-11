import { isProcessRunning, signalProcess } from "./drain-process.ts"
import { runtimeErrorDiagnostics } from "../error-diagnostics.ts"

/** The streams that `vitehub drain` writes to. */
export interface DrainOutput {
  stderr: { write: (chunk: string) => unknown }
  stdout: { write: (chunk: string) => unknown }
}

export const drainUsage = "vitehub drain MAINPID [STATUS_URL]"

type DrainStatus = "accepting" | "drained" | "draining" | "failed" | "invalid" | "unavailable"

async function readStatus(statusUrl: string): Promise<DrainStatus> {
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) {
      await response.body?.cancel()
      return "unavailable"
    }
    const body: unknown = await response.json()
    // SAFETY: The status endpoint response is validated before its value is used.
    const status = body && typeof body === "object" ? (body as { status?: unknown }).status : undefined
    return status === "accepting" || status === "drained" || status === "draining" || status === "failed"
      ? status
      : "invalid"
  }
  catch {
    return "unavailable"
  }
}

/**
 * `vitehub drain MAINPID [STATUS_URL]`: sends the drain signal to a running server and waits until its status endpoint
 * reports `drained`. Returns 0 when it drained, 1 when it failed, and 2 for a usage error.
 */
export async function runDrain(args: readonly string[], output: DrainOutput): Promise<number> {
  const [pidInput, statusInput] = args
  if (pidInput === "-h" || pidInput === "--help") {
    output.stdout.write(`Usage: ${drainUsage}\n`)
    return 0
  }
  const pid = Number(pidInput)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    output.stderr.write(`usage: ${drainUsage}\n`)
    return 2
  }
  const statusUrl = statusInput || "http://127.0.0.1:3000/api/drain"
  try {
    let signalAttempted = false
    while (isProcessRunning(pid)) {
      const status = await readStatus(statusUrl)
      if (status === "failed" || status === "invalid") throw runtimeErrorDiagnostics.RUNTIME_R0004({ message: `Process drain reported ${status}.` })
      if (status === "drained") return 0
      if (status === "accepting" && !signalAttempted) {
        // A denied signal still leaves the status endpoint as the source of truth.
        signalAttempted = signalProcess(pid) === "signaled"
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    throw runtimeErrorDiagnostics.RUNTIME_R0005({ message: `Process ${pid} exited before drain completed.` })
  }
  catch (error) {
    output.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
