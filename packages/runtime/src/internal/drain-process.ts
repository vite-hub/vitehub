/** Check whether a process still exists without confusing access denial for exit. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    // `kill(pid, 0)` reports EPERM when the process exists but belongs to a
    // user this process cannot inspect. Treat that as alive so the drain
    // client can continue through the status endpoint.
    try {
      return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM"
    }
    catch {
      return false
    }
  }
}

/** Request a drain signal, allowing status polling when signal permission is denied. */
export function signalProcess(pid: number): "signaled" | "permission-denied" {
  try {
    process.kill(pid, "SIGUSR2")
    return "signaled"
  }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM") {
      return "permission-denied"
    }
    throw error
  }
}
