#!/usr/bin/env node

const pidInput: string | undefined = process.argv[2]
const statusUrl: string = process.argv[3] || "http://127.0.0.1:3000/api/drain"
const pid: number = Number(pidInput)

if (!Number.isSafeInteger(pid) || pid <= 0) {
  console.error("usage: vitehub-drain MAINPID [STATUS_URL]")
  process.exit(2)
}

function running(): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function readStatus(): Promise<"accepting" | "drained" | "draining" | "failed" | "invalid" | "unavailable"> {
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return "unavailable"
    const body: unknown = await response.json()
    const status = typeof body === "object" && body !== null && "status" in body ? body.status : undefined
    return status === "accepting" || status === "drained" || status === "draining" || status === "failed"
      ? status
      : "invalid"
  }
  catch {
    return "unavailable"
  }
}

try {
  let signaled = false
  while (running()) {
    const status = await readStatus()
    if (status === "failed" || status === "invalid") throw new Error(`Process drain reported ${status}.`)
    if (status === "drained") process.exit(0)
    if (status === "accepting" && !signaled) {
      process.kill(pid, "SIGUSR2")
      signaled = true
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(`Process ${pid} exited before drain completed.`)
}
catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
