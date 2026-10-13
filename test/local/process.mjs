import { readdir, readFile } from "node:fs/promises"

export async function stopChild(child, graceMs = 500) {
  const exited = child.exitCode !== null || child.signalCode !== null
  const closed = exited ? Promise.resolve() : new Promise(resolve => child.once("close", resolve))
  signalChild(child, "SIGTERM")
  let timer
  try {
    await Promise.race([
      closed,
      new Promise(resolve => { timer = setTimeout(resolve, graceMs) }),
    ])
    // The process group can outlive its leader, so also stop surviving descendants.
    signalChild(child, "SIGKILL")
    await closed
    await waitForGroupExit(child)
  }
  finally {
    clearTimeout(timer)
  }
}

async function waitForGroupExit(child) {
  if (process.platform === "win32" || !child.pid) return
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    if (!(await hasLiveGroupMember(child.pid))) return
    try {
      process.kill(-child.pid, 0)
      signalChild(child, "SIGKILL")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    catch (error) {
      if (error.code === "ESRCH") return
      throw error
    }
  }
  if (await hasLiveGroupMember(child.pid)) throw new Error(`process group ${child.pid} did not exit after SIGKILL`)
}

export async function hasLiveGroupMember(pid) {
  if (process.platform !== "linux") return true
  const entries = await readdir("/proc")
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      if (Number(fields[2]) === pid && fields[0] !== "Z") return true
    }
    catch (error) {
      // A process can exit after /proc is enumerated but before its stat file is read.
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error
    }
  }
  return false
}

function signalChild(child, signal) {
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    return
  }
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  }
  catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

// Keep signal cleanup active until the provider has been reaped.
export function manageChild(...initialChildren) {
  const children = new Set(initialChildren)
  let cleanup
  let interrupted = false
  let stopping = false
  const pendingStops = new Set()
  const stop = () => {
    stopping = true
    cleanup ??= (async () => {
      while (children.size) {
        const snapshot = [...children]
        await Promise.all(snapshot.map(child => stopChild(child)))
        if (![...children].some(child => !snapshot.includes(child))) break
      }
      await Promise.all(pendingStops)
    })().finally(() => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    })
    return cleanup
  }
  stop.addChild = child => {
    children.add(child)
    if (stopping) {
      const pending = stopChild(child).finally(() => pendingStops.delete(pending))
      pendingStops.add(pending)
    }
  }
  stop.removeChild = child => children.delete(child)
  const onSignal = async signal => {
    if (interrupted) return
    interrupted = true
    try {
      await stop()
    }
    finally {
      // Restore Node's default signal termination, including its exit status.
      process.kill(process.pid, signal)
    }
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  return stop
}
