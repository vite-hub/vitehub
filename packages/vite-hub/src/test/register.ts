import { register } from "node:module"
import { isMainThread, Worker } from "node:worker_threads"

/**
 * `node --import vite-hub/test/register --test` gives app tests the modules that `vitehub()` generates, as Vitest does.
 * The first process starts one Vite server in a worker. The test processes that `node --test` starts inherit its
 * address and use the same server.
 */
const serverVariable = "VITEHUB_TEST_SERVER"

// Worker threads, such as the Vite server's own workers, keep Node's plain module loading.
if (isMainThread) {
  // Vitest sets it too. Libraries then keep their test behavior.
  process.env.NODE_ENV ??= "test"
  let worker: Worker | undefined
  let server = process.env[serverVariable]
  if (!server) {
    // The worker is not passed this flag, so it does not start another server.
    worker = new Worker(new URL("../internal/test-server.js", import.meta.url), { execArgv: [], workerData: { root: process.cwd() } })
    server = await new Promise<string>((resolve, reject) => {
      worker!.once("message", resolve)
      worker!.once("error", reject)
    })
    process.env[serverVariable] = server
  }
  register("../internal/test-loader.js", import.meta.url, { data: { server } })
  // The tests start after the Queue and Workflow test setup files ran. Only the hooks above resolve this module.
  const setup = "vitehub-test:setup"
  await import(setup)
  // The server answers until the process ends, without keeping it alive.
  worker?.unref()
}
