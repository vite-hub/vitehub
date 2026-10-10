import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import { promisify } from "node:util"
import { expect, it, vi } from "vitest"
import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { defineSchedule } from "../src/index.ts"
import { runScheduleCli, runScheduleRunCli, scheduleDevRunHeader, scheduleDevRunRoute } from "../src/cli.ts"
import { registerScheduleDevRunEndpoint } from "../src/dev-run.ts"
import { scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../src/dev.ts"
import { resetScheduleRuntime } from "../src/runtime.ts"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"

const tokenReads = vi.hoisted(() => vi.fn())
vi.mock("@vite-hub/internal/dev-token", async importOriginal => {
  const actual = await importOriginal<typeof import("@vite-hub/internal/dev-token")>()
  return { ...actual, readViteHubDevToken: (...args: Parameters<typeof actual.readViteHubDevToken>) => { tokenReads(...args); return actual.readViteHubDevToken(...args) } }
})

it("authenticates manual effects before SSR and runs the static command through the executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-manual-cli-"))
  const credential = await createViteHubDevToken(root, scheduleDevTokenNamespace)
  const another = await createViteHubDevToken(root, scheduleDevTokenNamespace)
  const effect = vi.fn()
  const ssrLoadModule = vi.fn(async () => ({ default: {
    sync: async () => defineSchedule("0 9 * * *", effect, { manual: true }),
    disabled: async () => defineSchedule("0 9 * * *", effect),
    fail: async () => defineSchedule("0 9 * * *", () => { throw new Error("Bearer private-secret") }, { manual: true }),
  } }))
  let middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined
  registerScheduleDevRunEndpoint({ config: { root, base: "/" }, middlewares: { use(handler: NonNullable<typeof middleware>) { middleware = handler } }, ssrLoadModule } as unknown as ViteDevServer, { serverId: credential.serverId })
  const server = createServer((req, res) => middleware!(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing server address")
  const url = `http://127.0.0.1:${address.port}`
  try {
    const publicHeaders = { "content-type": "application/json", [scheduleDevRunHeader]: "1" }
    for (const headers of [publicHeaders,
      { ...publicHeaders, [viteHubDevTokenHeader]: "wrong", [scheduleDevTokenServerHeader]: credential.serverId },
      { ...publicHeaders, [viteHubDevTokenHeader]: credential.token.slice(0, -1), [scheduleDevTokenServerHeader]: credential.serverId },
      { ...publicHeaders, [viteHubDevTokenHeader]: `${credential.token}0`, [scheduleDevTokenServerHeader]: credential.serverId },
      { ...publicHeaders, [viteHubDevTokenHeader]: another.token, [scheduleDevTokenServerHeader]: another.serverId },
      { ...publicHeaders, origin: "not-an-origin", [viteHubDevTokenHeader]: credential.token, [scheduleDevTokenServerHeader]: credential.serverId }]) {
      expect((await fetch(`${url}${scheduleDevRunRoute}`, { body: '{"name":"sync"}', headers, method: "POST" })).status).toBe(403)
    }
    expect(ssrLoadModule).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    const discovery = await (await fetch(`${url}${scheduleDevRunRoute}`, { headers: publicHeaders })).text()
    expect(JSON.parse(discovery)).toEqual({ root, scheduleDevTokenServerId: credential.serverId })
    expect(discovery).not.toContain(credential.token)
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    await symlink(resolve(import.meta.dirname, ".."), join(root, "node_modules/@vite-hub/schedule"), "dir")
    await writeFile(join(root, "vite.config.mjs"), 'import { hubSchedule } from "@vite-hub/schedule/vite"; export default { plugins: [hubSchedule()] };')
    const executable = resolve(import.meta.dirname, "../../cli/src/index.ts")
    const options = { cwd: root, env: { ...process.env, VITEHUB_DEV_SERVER_URL: url }, timeout: 30_000 }
    const success = await promisify(execFile)(process.execPath, [executable, "schedule", "run", "sync", "--json"], options)
    expect(success.stderr).toBe("")
    expect(JSON.parse(success.stdout)).toMatchObject({ id: expect.stringMatching(/^srun_manual_sync_/), scheduleId: "sync", status: "succeeded" })
    expect(effect).toHaveBeenCalledTimes(1)
    const failed = await promisify(execFile)(process.execPath, [executable, "schedule", "run", "disabled", "--json"], options).then(() => undefined, (error: unknown) => error)
    expect(failed).toMatchObject({ code: 1, stderr: "" })
    const stdout = Reflect.get(Object(failed), "stdout")
    expect(JSON.parse(String(stdout))).toMatchObject({ error: { message: expect.stringContaining("403") } })
    expect(effect).toHaveBeenCalledTimes(1)
    let output = ""
    expect(await runScheduleCli(["run", "fail", "--server", url, "--json"], { cwd: root, rootDir: root, env: {}, stderr: { write: () => {} }, stdout: { write: chunk => { output += String(chunk) } } })).toBe(1)
    expect(JSON.parse(output)).toMatchObject({ status: "failed", error: { message: "Bearer [redacted]" } })
    expect(output).not.toContain("private-secret")
  }
  finally {
    resetScheduleRuntime()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await removeViteHubDevToken(root, { namespace: scheduleDevTokenNamespace, serverId: credential.serverId })
    await removeViteHubDevToken(root, { namespace: scheduleDevTokenNamespace, serverId: another.serverId })
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it("preserves authenticated Console targeting for static run and redacts its result", async () => {
  let stdout = ""
  let stderr = ""
  const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json({ run: { id: "srun_manual_sync_1", status: "failed", error: { name: "access_token=secret-name", message: "Bearer private-secret", stack: "secret-stack" } } }))
  expect(await runScheduleRunCli(["sync", "--url", "https://app.example.com/base/", "--json"], { env: { VITEHUB_CONSOLE_AUTHORIZATION: "Bearer credential" }, stdout: { write: chunk => { stdout += String(chunk) } }, stderr: { write: chunk => { stderr += String(chunk) } } }, { fetch })).toBe(1)
  expect(fetch).toHaveBeenCalledWith("https://app.example.com/base/_vitehub/schedules/run", expect.objectContaining({ body: '{"name":"sync"}', headers: expect.any(Headers), method: "POST", redirect: "manual" }))
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer credential")
  expect(JSON.parse(stdout)).toMatchObject({ status: "failed", error: { name: "access_token=[redacted]", message: "Bearer [redacted]" } })
  expect(stdout).not.toMatch(/secret-name|private-secret|secret-stack/)
  expect(stderr).toBe("")
})

it("rejects retained manual-run middleware after the Vite server closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-manual-close-"))
  const credential = await createViteHubDevToken(root, scheduleDevTokenNamespace)
  const httpServer = new EventEmitter()
  let middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined
  registerScheduleDevRunEndpoint({
    config: { root, base: "/" },
    httpServer,
    middlewares: { use(handler: NonNullable<typeof middleware>) { middleware = handler } },
    ssrLoadModule: vi.fn(),
  } as unknown as ViteDevServer, { serverId: credential.serverId })
  httpServer.emit("close")
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
  middleware!(Object.assign(Readable.from([]), {
    headers: { host: "localhost" },
    method: "GET",
    url: scheduleDevRunRoute,
  }) as unknown as IncomingMessage, response as unknown as ServerResponse, vi.fn())
  expect(response.statusCode).toBe(403)
  expect(response.end).toHaveBeenCalled()
  await removeViteHubDevToken(root, { namespace: scheduleDevTokenNamespace, serverId: credential.serverId })
  await rm(root, { recursive: true, force: true })
})


it.each(["/different-app", undefined])("rejects discovery root %s before reading credentials or sending a static run", async root => {
  tokenReads.mockClear()
  const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json({ root, scheduleDevTokenServerId: "other-instance" }))
  let stdout = ""
  let stderr = ""
  expect(await runScheduleRunCli(["sync", "--json"], { cwd: "/expected-app", rootDir: "/expected-app", env: {}, stdout: { write: chunk => { stdout += String(chunk) } }, stderr: { write: chunk => { stderr += String(chunk) } } }, { fetch })).toBe(1)
  expect(tokenReads).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(stdout)).toHaveProperty("error.message")
  expect(stderr).toBe("")
})
