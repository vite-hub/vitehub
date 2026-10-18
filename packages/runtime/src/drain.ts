#!/usr/bin/env node

import { hasRuntimeType } from "./internal/runtime-type.ts"
import { isProcessRunning, signalProcess } from "./internal/drain-process.ts"
import { runtimeErrorDiagnostics } from "./error-diagnostics.ts"

const pidInput: string | undefined = process.argv[2]
const statusUrl: string = process.argv[3] || "http://127.0.0.1:3000/api/drain"
const pid: number = Number(pidInput)

if (pidInput === "-h" || pidInput === "--help") {
  console.log("Usage: vitehub-drain MAINPID [STATUS_URL]")
  process.exit(0)
}

if (!Number.isSafeInteger(pid) || pid <= 0) {
  console.error("usage: vitehub-drain MAINPID [STATUS_URL]")
  process.exit(2)
}

async function readStatus(): Promise<"accepting" | "drained" | "draining" | "failed" | "invalid" | "unavailable"> {
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return "unavailable"
    const body: unknown = await response.json()
    // SAFETY: The status endpoint response is validated before its value is used.
    const status = body && hasRuntimeType(body, "object") ? (body as { status?: unknown }).status : undefined
    return status === "accepting" || status === "drained" || status === "draining" || status === "failed"
      ? status
      : "invalid"
  }
  catch {
    return "unavailable"
  }
}

try {
  let signalAttempted = false
  while (isProcessRunning(pid)) {
    const status = await readStatus()
    if (status === "failed" || status === "invalid") throw runtimeErrorDiagnostics.RUNTIME_R0004({ message: `Process drain reported ${status}.` })
    if (status === "drained") process.exit(0)
    if (status === "accepting" && !signalAttempted) {
      // A denied signal still leaves the status endpoint as the source of truth.
      signalAttempted = signalProcess(pid) === "signaled"
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw runtimeErrorDiagnostics.RUNTIME_R0005({ message: `Process ${pid} exited before drain completed.` })
}
catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
