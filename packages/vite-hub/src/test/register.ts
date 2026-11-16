import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { register } from "node:module"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { isMainThread, Worker } from "node:worker_threads"

/**
 * `node --import vite-hub/test/register --test` gives app tests the modules that `vitehub()` generates, as Vitest does.
 * One Vite server of the app answers the module hooks. `node --test` runs each test file in its own process, and only
 * those processes load this module, so the first one starts the server as a process that every test process of the run
 * shares. A process that runs its tests itself starts the server in a worker.
 */

const serverFile = new URL("../internal/test-server.js", import.meta.url)

function startWorker(root: string): Promise<{ server: string, worker: Worker }> {
  // The worker is not passed the `--import` flag, so it does not start another server.
  const worker = new Worker(serverFile, { execArgv: [], workerData: { root } })
  return new Promise((resolve, reject) => {
    worker.once("message", (server: string) => resolve({ server, worker }))
    worker.once("error", reject)
  })
}

/** The address of the server of this `node --test` run. The test processes of one run share the runner's pid. */
async function sharedServer(root: string, runner: number): Promise<string> {
  const directory = join(root, ".vitehub", "test-server")
  mkdirSync(directory, { recursive: true })
  const addressFile = join(directory, `${runner}.url`)
  try {
    writeFileSync(`${addressFile}.lock`, "", { flag: "wx" })
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_OPTIONS" && name !== "NODE_TEST_CONTEXT"))
    spawn(process.execPath, [fileURLToPath(serverFile), root, addressFile, String(runner)], { detached: true, env, stdio: "ignore" }).unref()
  }
  catch (error) {
    // Another test process of this run starts the server.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  for (let attempt = 0; attempt < 1200; attempt++) {
    try {
      return readFileSync(addressFile, "utf8")
    }
    catch {
      await sleep(50)
    }
  }
  throw new Error(`[vitehub] The Vite server of vite-hub/test did not start in 60 seconds. Delete ${directory} and run the tests again.`)
}

// Worker threads, such as the Vite server's own workers, keep Node's plain module loading.
if (isMainThread) {
  // Vitest sets it too. Libraries then keep their test behavior.
  process.env.NODE_ENV ??= "test"
  const root = process.cwd()
  const started = process.env.NODE_TEST_CONTEXT ? undefined : await startWorker(root)
  const server = started?.server ?? await sharedServer(root, process.ppid)
  register("../internal/test-loader.js", import.meta.url, { data: { server } })
  // The tests start after the Queue and Workflow test setup files ran. Only the hooks above resolve this module.
  const setup = "vitehub-test:setup"
  await import(setup)
  // The server answers until the process ends, without keeping it alive.
  started?.worker.unref()
}
