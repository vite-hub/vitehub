import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createViteHubDevToken, readViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevRuntimeRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../src/dev.ts"
import { handleScheduleDevRequest } from "../src/runtime/dev.ts"
import { resetScheduleRuntime } from "../src/runtime/state.ts"
import { hubSchedule } from "../src/vite.ts"
import { runScheduleCli } from "../src/cli.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ScheduleDefinitionRegistry } from "../src/types.ts"

async function startDevServer(root: string, viteRoot: string, registry: ScheduleDefinitionRegistry) {
  const plugin = hubSchedule({ projectRoot: root })
  const config: { root: string, nitro?: { handlers?: { handler: string }[] } } = { root: viteRoot }
  await (plugin.config as (config: Record<string, unknown>, env: { command: "serve", mode: string }) => Promise<void>)(config, { command: "serve", mode: "development" })
  await (plugin.configResolved as (config: Record<string, unknown>) => Promise<void>)({ build: { outDir: "dist" }, command: "serve", resolve: { alias: [] }, root: viteRoot })
  const handler = config.nitro!.handlers![0]!.handler
  const handlerSource = await readFile(handler, "utf8")
  const devContext: { rootDir: string, serverId?: string } = JSON.parse(handlerSource.match(/handleViteHubDevRequest\(event.req, \{ \.\.\.(\{.*?\}), "registry": viteHubDevContext0 \}\)/)![1]!)
  // The generated handler passes the Static Schedule registry virtual module. The test passes its own registry.
  const runtimeContext = { ...devContext, registry }
  const middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)[] = []
  const httpServer = createServer((req, res) => {
    middleware[0]!(req, res, () => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const headers = Object.fromEntries(Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]))
        const response = await handleScheduleDevRequest(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }), runtimeContext)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })().catch(error => { res.writeHead(500); res.end(String(error)) })
    })
  })
  await (plugin.configureServer as (server: Record<string, unknown>) => Promise<void>)({
    config: { root: viteRoot, server: { host: "0.0.0.0" } }, httpServer,
    environments: { nitro: { dispatchFetch: (request: Request) => handleScheduleDevRequest(request, runtimeContext) } },
    middlewares: { use: (handler: (typeof middleware)[number]) => { middleware.push(handler) } },
  })
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve))
  const address = httpServer.address()
  if (!address || typeof address === "string") throw new Error("Missing test server address")
  const url = `http://127.0.0.1:${address.port}`
  return { devContext, handler, httpServer, runtimeContext, url }
}

describe("Schedule private dev authority", () => {
  it.each([false, true])("rejects network runs and permits the project CLI with nested Vite root %s", async nested => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-dev-auth-"))
    const viteRoot = nested ? join(root, "apps/web") : root
    await mkdir(viteRoot, { recursive: true })
    const invoked = vi.fn()
    const registry: ScheduleDefinitionRegistry = { digest: async () => ({ cron: "0 9 * * *", handler: async () => { invoked() }, options: { manual: true } }) }
    const first = await startDevServer(root, viteRoot, registry)
    const second = await startDevServer(root, viteRoot, registry)
    const { devContext, httpServer, runtimeContext, url } = first
    const publicGuard = { [scheduleDevHeader]: scheduleDevHeaderValue, "content-type": "application/json" }
    let serverId = ""
    let token: string | undefined
    const other = await createViteHubDevToken(join(root, "other"), scheduleDevTokenNamespace)
    const stale = await createViteHubDevToken(viteRoot, scheduleDevTokenNamespace)
    let secondServerId = ""
    try {
      const discoveryText = await (await fetch(`${url}${scheduleDevRoute}`, { headers: publicGuard })).text()
      const discovery = JSON.parse(discoveryText)
      serverId = discovery.scheduleDevTokenServerId
      token = await readViteHubDevToken(devContext.rootDir, { namespace: scheduleDevTokenNamespace, serverId })
      expect(token).toBeTruthy()
      expect(discoveryText).not.toContain(token!)
      const secondDiscovery = await (await fetch(`${second.url}${scheduleDevRoute}`, { headers: publicGuard })).json() as { scheduleDevTokenServerId: string }
      secondServerId = secondDiscovery.scheduleDevTokenServerId
      const secondToken = await readViteHubDevToken(viteRoot, { namespace: scheduleDevTokenNamespace, serverId: secondServerId })
      expect(secondToken).toBeTruthy()
      expect(secondServerId).not.toBe(serverId)
      for (const route of [scheduleDevRoute, scheduleDevRuntimeRoute]) {
        for (const operation of ["run-static", "runs"]) {
          for (const headers of [publicGuard,
            { ...publicGuard, [viteHubDevTokenHeader]: "wrong", [scheduleDevTokenServerHeader]: serverId },
            { ...publicGuard, [viteHubDevTokenHeader]: other.token, [scheduleDevTokenServerHeader]: other.serverId },
            { ...publicGuard, [viteHubDevTokenHeader]: secondToken!, [scheduleDevTokenServerHeader]: secondServerId },
            { ...publicGuard, [viteHubDevTokenHeader]: stale.token, [scheduleDevTokenServerHeader]: stale.serverId }]) {
            const response = await fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify({ id: "digest", operation }) })
            expect(response.status).toBe(403)
          }
        }
      }
      for (const operation of ["run-static", "runs"]) {
        const response = await fetch(`${second.url}${scheduleDevRuntimeRoute}`, { method: "POST", headers: {
          ...publicGuard, [viteHubDevTokenHeader]: token!, [scheduleDevTokenServerHeader]: serverId,
        }, body: JSON.stringify({ id: "digest", operation }) })
        expect(response.status).toBe(403)
      }
      expect(first.handler).not.toBe(second.handler)
      expect(await readFile(first.handler, "utf8")).toContain(JSON.stringify(first.devContext))
      expect(first.devContext.serverId).toBe(serverId)
      expect(second.devContext.serverId).toBe(secondServerId)
      expect((await handleScheduleDevRequest(new Request(`${url}${scheduleDevRuntimeRoute}`, {
        method: "POST", headers: { ...publicGuard, [viteHubDevTokenHeader]: token!, [scheduleDevTokenServerHeader]: serverId },
        body: JSON.stringify({ id: "digest", operation: "run-static" }),
      }), { registry, rootDir: viteRoot })).status).toBe(403)
      expect(invoked).not.toHaveBeenCalled()
      await mkdir(join(viteRoot, "node_modules/@vite-hub"), { recursive: true })
      await symlink(resolve(import.meta.dirname, ".."), join(viteRoot, "node_modules/@vite-hub/schedule"), "dir")
      await writeFile(join(viteRoot, "vite.config.mjs"), `import { hubSchedule } from "@vite-hub/schedule/vite"; export default { plugins: [hubSchedule({ projectRoot: ${JSON.stringify(root)} })] };`)
      const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/src/index.ts"), "schedule", "run", "digest", "--server", url, "--json"], { cwd: viteRoot, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", chunk => { stdout += String(chunk) })
      child.stderr.on("data", chunk => { stderr += String(chunk) })
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
      expect(exitCode, stderr).toBe(0)
      expect(JSON.parse(stdout).status).toBe("succeeded")
      expect(stdout + stderr).not.toContain(token!)
      expect(stderr).toBe("")
      expect(discovery.root).toBe(viteRoot)
      expect(devContext.rootDir).toBe(viteRoot)
      for (const serverUrl of [url, second.url]) {
        for (const operation of ["run", "runs"]) {
          let stdout = ""
          let stderr = ""
          expect(await runScheduleCli([operation, "digest", operation === "run" ? "--server" : "--url", serverUrl, "--json"], {
            cwd: viteRoot, rootDir: viteRoot, env: {}, stdout: { write: chunk => { stdout += String(chunk); return true } }, stderr: { write: chunk => { stderr += String(chunk); return true } },
          })).toBe(0)
          expect(JSON.parse(stdout)).toHaveProperty(operation === "run" ? "status" : "runs")
          expect(stdout + stderr).not.toContain(token!)
          expect(stdout + stderr).not.toContain(secondToken!)
          expect(stderr).toBe("")
        }
      }
      expect(invoked).toHaveBeenCalledTimes(3)
    }
    finally {
      await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))
      if (serverId) await vi.waitFor(async () => { expect(await readViteHubDevToken(devContext.rootDir, { namespace: scheduleDevTokenNamespace, serverId })).toBeUndefined() })
      if (serverId && token) {
        const effectsBeforeClosedRequests = invoked.mock.calls.length
        for (const operation of ["run-static", "runs"]) {
          expect((await handleScheduleDevRequest(new Request(`${url}${scheduleDevRuntimeRoute}`, {
            method: "POST", headers: { ...publicGuard, [viteHubDevTokenHeader]: token, [scheduleDevTokenServerHeader]: serverId },
            body: JSON.stringify({ id: "digest", operation }),
          }), runtimeContext)).status).toBe(403)
        }
        expect(invoked).toHaveBeenCalledTimes(effectsBeforeClosedRequests)
      }
      if (secondServerId) {
        expect(await readViteHubDevToken(viteRoot, { namespace: scheduleDevTokenNamespace, serverId: secondServerId })).toBeTruthy()
        expect(await runScheduleCli(["runs", "digest", "--url", second.url, "--json"], {
          cwd: viteRoot, rootDir: viteRoot, env: {}, stdout: { write: () => true }, stderr: { write: () => true },
        })).toBe(0)
      }
      await new Promise<void>((resolve, reject) => second.httpServer.close(error => error ? reject(error) : resolve()))
      if (secondServerId) await vi.waitFor(async () => { expect(await readViteHubDevToken(viteRoot, { namespace: scheduleDevTokenNamespace, serverId: secondServerId })).toBeUndefined() })
      await removeViteHubDevToken(viteRoot, { namespace: scheduleDevTokenNamespace, serverId: stale.serverId })
      await removeViteHubDevToken(join(root, "other"), { namespace: scheduleDevTokenNamespace, serverId: other.serverId })
      resetScheduleRuntime()
      await rm(root, { recursive: true, force: true })
    }
  })
})
