// A command can leave its process group with `setsid` or a double fork, so killing the group
// misses it. It still keeps the environment it started with, which Linux shows in /proc/<pid>/environ.
import { readdir, readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

const maxRounds = 10

/**
 * Stops every process of this user that started with `name=value` in its environment: SIGTERM, then
 * SIGKILL after `graceMs`. It repeats while marked processes remain, because a dying process can start
 * another one. Does nothing outside Linux.
 */
export async function stopMarkedProcesses(name: string, value: string, options: { graceMs?: number } = {}): Promise<void> {
  if (process.platform !== "linux") return
  const marker = `\0${name}=${value}\0`
  for (let round = 0; round < maxRounds; round++) {
    const marked = await markedProcesses(marker)
    if (!marked.length) return
    for (const pid of marked) signal(pid, "SIGTERM")
    await delay(options.graceMs ?? 250)
    for (const pid of await markedProcesses(marker)) signal(pid, "SIGKILL")
    await delay(10)
  }
}

async function markedProcesses(marker: string): Promise<number[]> {
  const entries = await readdir("/proc")
  const pids = entries.filter(entry => /^\d+$/.test(entry)).map(Number).filter(pid => pid !== process.pid)
  // Processes of other users answer EACCES and exited ones ENOENT or ESRCH. A zombie has an empty environment.
  const environments = await Promise.all(pids.map(pid => readFile(`/proc/${pid}/environ`, "latin1").catch(() => "")))
  return pids.filter((_, index) => `\0${environments[index]}`.includes(marker))
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  }
  catch {
    // The process already exited.
  }
}
