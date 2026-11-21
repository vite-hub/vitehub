import { createRequire } from "node:module"
import { Worker } from "node:worker_threads"

// A libSQL connection checkpoints its WAL inside the commit that crosses 1000 pages, so the
// commit's caller waits for the page writes and both fsyncs. libSQL runs synchronously on the
// caller's thread, which for Agent State is the server's event loop. This worker checkpoints the
// same file from its own thread first. A PASSIVE checkpoint takes no lock that writers or readers
// wait on, and once it has copied every frame, the next commit restarts the WAL instead of
// checkpointing. The commit-time checkpoint still runs if this worker falls behind.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads")
const Database = require(workerData.addon)
const db = new Database(workerData.path)
const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)")
let reported = false
const timer = setInterval(() => {
  try {
    checkpoint.get()
  } catch (error) {
    if (!reported) parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
    reported = true
  }
}, workerData.intervalMs)
parentPort.once("message", () => {
  clearInterval(timer)
  db.close()
  parentPort.close()
})
`

interface Checkpointer {
  references: number
  timer?: ReturnType<typeof setTimeout>
  worker?: Worker
  exited?: Promise<unknown>
}

const checkpointers = new Map<string, Checkpointer>()

/**
 * Resolves the libSQL package that `@libsql/client` loads. The worker must load the same native
 * addon: a second SQLite copy in one process loses the other's POSIX locks on close.
 */
function libsqlAddon(): string | undefined {
  for (const from of [() => import.meta.resolve("@libsql/client"), () => import.meta.url]) {
    try {
      return createRequire(from()).resolve("libsql")
    } catch {}
  }
}

function spawn(path: string, addon: string, intervalMs: number, checkpointer: Checkpointer) {
  const worker = new Worker(workerSource, { eval: true, workerData: { addon, intervalMs, path } })
  worker.unref()
  const fellBack = (reason: string) => console.warn(`[vitehub] SQLite WAL checkpoints for ${path} fell back to commits: ${reason}`)
  worker.on("message", (message: { error?: string }) => {
    if (message.error) fellBack(message.error)
  })
  worker.on("error", error => fellBack(error.message))
  checkpointer.exited = new Promise(resolve => worker.once("exit", resolve))
  checkpointer.worker = worker
}

/**
 * Checkpoints the WAL database at `path` every `intervalMs` on a worker thread until every caller
 * has called the returned stop function. The worker starts after the first interval, so a
 * short-lived connection never starts one. Returns undefined when libSQL cannot be resolved.
 */
export function startWalCheckpointer(path: string, intervalMs = 5_000): (() => Promise<void>) | undefined {
  let checkpointer = checkpointers.get(path)
  if (!checkpointer) {
    const addon = libsqlAddon()
    if (!addon) return
    const created: Checkpointer = { references: 0 }
    created.timer = setTimeout(() => spawn(path, addon, intervalMs, created), intervalMs)
    created.timer.unref()
    checkpointer = created
    checkpointers.set(path, checkpointer)
  }
  const owned = checkpointer
  owned.references++
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    if (--owned.references > 0) return
    if (checkpointers.get(path) === owned) checkpointers.delete(path)
    clearTimeout(owned.timer)
    if (!owned.worker) return
    // An unreferenced worker would let the process exit while the caller awaits its close.
    owned.worker.ref()
    owned.worker.postMessage("stop")
    await owned.exited
  }
}
