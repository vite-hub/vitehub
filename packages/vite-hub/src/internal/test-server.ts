import { randomBytes } from "node:crypto"
import { renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { pathToFileURL } from "node:url"
import { parentPort, workerData } from "node:worker_threads"

import type { ViteDevServer } from "vite"

/**
 * The Vite server of `vite-hub/test/register`. It runs one Vite server of the app, as Vitest does, and answers the
 * module hooks of the test processes over a local port. It runs outside the test's main thread because Node blocks
 * that thread while it loads modules, and the hooks thread passes its own imports through the hooks.
 *
 * - In a worker thread of a test process, it posts its address to the process.
 * - As its own process for the test processes of `node --test` (`<root> <address file> <runner pid>`), it writes its
 *   address to the file, and stops when the runner process ends.
 */

const [root, addressFile, runner] = parentPort
  ? [(workerData as { root: string }).root]
  : [process.argv[2]!, process.argv[3]!, Number(process.argv[4])]

async function startVite(): Promise<ViteDevServer> {
  // The ViteHub plugins write and add the same test setup files as for Vitest. This changes only this thread.
  process.env.VITEST ??= "true"
  const [{ createServer }, { loadViteHubCliConfig }] = await Promise.all([import("vite"), import("./cli-config.ts")])
  let created: ViteDevServer | undefined
  // The `vite.config.ts` of the app, or the Vite options of its `nuxt.config.ts`.
  await loadViteHubCliConfig(root, "serve", undefined, {
    async resolveViteConfig(inlineConfig) {
      created = await createServer({
        ...inlineConfig,
        appType: "custom",
        logLevel: inlineConfig.logLevel ?? "warn",
        server: { ...inlineConfig.server, hmr: false, middlewareMode: true, watch: null, ws: false },
      })
      return created.config
    },
  })
  // SAFETY: loadViteHubCliConfig calls resolveViteConfig once before it returns.
  return created!
}

const vite = startVite()
// The hooks report a failed start when they ask for a module.
vite.catch(() => {})

async function answer(url: URL): Promise<unknown> {
  const { environments, config } = await vite
  if (url.pathname.endsWith("/setup")) {
    // SAFETY: Vitest's `test` options are not part of Vite's config type. The ViteHub plugins add `setupFiles` to it.
    const setupFiles = (config as { test?: { setupFiles?: string | string[] } }).test?.setupFiles ?? []
    return [setupFiles].flat().map(file => pathToFileURL(file).href)
  }
  if (url.pathname.endsWith("/resolve")) {
    const resolved = await environments.ssr.pluginContainer.resolveId(url.searchParams.get("specifier")!, url.searchParams.get("importer") ?? undefined)
    return resolved && !resolved.external ? resolved.id : null
  }
  const loaded = await environments.ssr.pluginContainer.load(url.searchParams.get("id")!)
  return typeof loaded === "string" ? loaded : loaded?.code ?? null
}

// Only a process that knows the token can read the app's generated modules.
const token = randomBytes(16).toString("hex")
const http = createHttpServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost")
  if (!url.pathname.startsWith(`/${token}/`)) {
    response.writeHead(404).end()
    return
  }
  answer(url).then(
    value => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value)),
    (error: unknown) => response.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.stack ?? error.message : String(error)),
  )
})
http.listen(0, "127.0.0.1", () => {
  const address = http.address()
  // SAFETY: A TCP server that listens has an AddressInfo address.
  const url = `http://127.0.0.1:${(address as { port: number }).port}/${token}`
  if (parentPort) {
    parentPort.postMessage(url)
    return
  }
  // The test processes read the file as soon as it exists, so it appears with its whole content.
  writeFileSync(`${addressFile}.tmp`, url)
  renameSync(`${addressFile}.tmp`, addressFile!)
  setInterval(() => {
    try {
      process.kill(runner!, 0)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return
      rmSync(addressFile!, { force: true })
      rmSync(`${addressFile}.lock`, { force: true })
      process.exit(0)
    }
  }, 1000)
})
