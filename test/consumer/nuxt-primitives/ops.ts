import { existsSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

import { chromium } from "playwright-core"
import { afterAll } from "vitest"

import { createConsoleKeyPair, signConsoleRequest } from "../../../packages/internal/src/console-signature.ts"
import { run } from "../packed-app.ts"
import { envDeclaration, expectJson, setServerEnv, type Mode, type PrepareContext, type PrimitiveRow, type ProbeContext, type Target } from "./row.ts"

const contract = process.env.VITEHUB_CONSUMER_CONTRACT === "1"

async function eventually<T>(check: () => Promise<T>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (true) {
    try {
      return await check()
    }
    catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}

async function retry(attempts: number, check: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await check()
    }
    catch (error) {
      if (attempt === attempts) throw error
    }
  }
}

function expectEqual(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

function probeId(mode: Mode, name: string) {
  return `${name}-${mode}-${crypto.randomUUID().slice(0, 8)}`
}

function commandEnv() {
  return { ...process.env, CI: "1", NO_COLOR: "1", NUXT_TELEMETRY_DISABLED: "1" }
}

interface PostHogEvent {
  event: string
  properties: Record<string, unknown>
}

interface FakeServices {
  origin: string
  events: PostHogEvent[]
}

async function startFakeServices(): Promise<FakeServices> {
  const events: PostHogEvent[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => { body += chunk })
    request.on("end", () => {
      response.setHeader("content-type", "application/json")
      const path = request.url ?? "/"
      if (path.startsWith("/api/v1/")) {
        response.end(JSON.stringify({ authorization: request.headers.authorization ?? null, full_name: "acme/web", path }))
        return
      }
      if (path === "/batch/") {
        const { batch } = JSON.parse(body) as { batch: PostHogEvent[] }
        events.push(...batch)
      }
      response.end(JSON.stringify({ status: 1 }))
    })
  })
  server.listen(0, "127.0.0.1")
  await new Promise(resolve => server.once("listening", resolve))
  server.unref()
  afterAll(() => { server.close() })
  return { events, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const fake: FakeServices = contract ? await startFakeServices() : { events: [], origin: "http://127.0.0.1:9" }

const consoleKey = contract ? await createConsoleKeyPair() : { privateKey: "", publicKey: "" }
const consoleKeyName = "PRIMITIVES"

function consoleConfig(origin: string) {
  return { console: true, publicUrl: origin }
}

const consolePrepared = new Set<Mode>()
async function prepareConsole(context: PrepareContext) {
  if (consolePrepared.has(context.mode)) return
  consolePrepared.add(context.mode)
  await setServerEnv(context, { [`VITEHUB_CONSOLE_KEY_${consoleKeyName}`]: consoleKey.publicKey })
}

type ConsoleReply = { ok: true, value: unknown } | { ok: false, status: number, error: Record<string, unknown> }

async function callConsole({ fetch, origin }: Pick<ProbeContext, "fetch" | "origin">, operation: string, input: unknown = {}, signed = true): Promise<ConsoleReply> {
  const body = JSON.stringify({ a: [input], i: operation, m: operation, t: "q" })
  const signature = signed
    ? await signConsoleRequest({ body, caller: { via: "cli" }, key: { name: consoleKeyName, privateKey: consoleKey.privateKey }, method: "POST", url: `${origin}/_vitehub/rpc` })
    : {}
  const response = await fetch("/_vitehub/rpc", { body, headers: { "content-type": "application/json", "x-vitehub-console": "1", ...signature }, method: "POST" })
  const text = await response.text()
  let reply: Record<string, unknown>
  try {
    reply = JSON.parse(text) as Record<string, unknown>
  }
  catch {
    throw new Error(`${operation} answered ${response.status}: ${text.slice(0, 2000)}`)
  }
  if (reply.t === "s" && "r" in reply && response.ok) return { ok: true, value: reply.r }
  const error = reply.t === "s" && reply.e instanceof Object ? reply.e as Record<string, unknown> : reply
  return { error, ok: false, status: response.status }
}

async function consoleValue(context: Pick<ProbeContext, "fetch" | "origin">, operation: string, input: unknown = {}) {
  const reply = await callConsole(context, operation, input)
  if (!reply.ok) throw new Error(`${operation} answered ${reply.status}: ${JSON.stringify(reply.error)}`)
  return reply.value
}

const observability = {
  posthog: {
    apiKey: envDeclaration(`env({ secret: true, source: env.source("PRIMITIVE_POSTHOG_KEY") })`),
    host: fake.origin,
  },
  service: "nuxt-primitives",
}

interface LogPage {
  page: { entries: { level: string, service: string, data: Record<string, unknown> }[] }
}

function nitroPreset(target: Target) {
  return target === "cloudflare" ? "cloudflare-module" : "node-server"
}

interface BundleReport {
  schemaVersion: number
  host?: string
  client?: { bytes: number }
  server?: { bytes: number }
}

async function readBundleReport(appDir: string): Promise<BundleReport> {
  const { stdout } = await run("pnpm", ["exec", "vitehub", "bundle", "--json"], appDir, commandEnv())
  return JSON.parse(stdout) as BundleReport
}

const deviceText = (state: { value: string, status: string, stored: string }) =>
  `(() => { const read = id => document.getElementById(id)?.textContent; return read("value") === ${JSON.stringify(state.value)} && read("status") === ${JSON.stringify(state.status)} && read("stored") === ${JSON.stringify(state.stored)} })()`

export const ops: PrimitiveRow[] = [
  {
    id: "console",
    packages: [],
    vitehub: (_target, origin) => consoleConfig(origin),
    files: {},
    prepare: prepareConsole,
    async probe(context) {
      const unsigned = await callConsole(context, "sections.list", {}, false)
      expectEqual("An unsigned sections.list", unsigned.ok ? unsigned : { code: unsigned.error.code, status: unsigned.status }, { code: "CONSOLE_SIGNATURE_MISSING", status: 401 })
      const { sections } = await consoleValue(context, "sections.list") as { sections: string[] }
      expectEqual("The Logs section of the Console", sections.includes("logs"), true)
    },
  },
  {
    id: "logs",
    packages: ["@vite-hub/agent", "@vite-hub/env"],
    dependencies: { evlog: "2.37.1", "posthog-node": "6.0.6" },
    vitehub: (_target, origin) => ({ ...consoleConfig(origin), logs: { source: "./server/primitive-log-source.ts" }, observability }),
    files: {
      "server/primitive-log-buffer.ts": `
        import { createLogBuffer, type LogBuffer } from "vite-hub/logs/memory"

        const key = Symbol.for("nuxt-primitives.log-buffer")
        const scope = globalThis as typeof globalThis & { [key]?: LogBuffer }
        export function primitiveLogBuffer(): LogBuffer {
          return scope[key] ??= createLogBuffer()
        }
      `,
      "server/primitive-log-source.ts": `
        import { primitiveLogBuffer } from "./primitive-log-buffer"

        export default primitiveLogBuffer().source
      `,
      "server/plugins/primitive-logs.ts": `
        import { definePlugin } from "nitro"
        import { primitiveLogBuffer } from "../primitive-log-buffer"

        export default definePlugin((nitroApp) => {
          nitroApp.hooks.hook("evlog:drain", primitiveLogBuffer().drain)
        })
      `,
      "server/api/primitives/logs.get.ts": `
        import { useLogger } from "evlog/nitro/v3"
        import { defineEventHandler, getQuery } from "nitro/h3"

        export default defineEventHandler((event) => {
          const probe = String(getQuery(event).probe)
          useLogger(event).set({ primitive: { probe } })
          return { probe }
        })
      `,
    },
    prepare: async (context) => {
      await prepareConsole(context)
      await setServerEnv(context, { PRIMITIVE_POSTHOG_KEY: "phc_nuxt_primitives" })
    },
    async probe(context) {
      const probe = probeId(context.mode, "log")
      await expectJson(await context.fetch(`/api/primitives/logs?probe=${probe}`), { probe })
      await eventually(async () => {
        const { page } = await consoleValue(context, "logs.list", { text: probe }) as LogPage
        expectEqual(`The log entries of ${probe}`, page.entries.map(entry => ({ level: entry.level, primitive: entry.data.primitive, service: entry.service })), [
          { level: "info", primitive: { probe }, service: "nuxt-primitives" },
        ])
      }, 20_000)
    },
  },
  {
    id: "observability",
    packages: ["@vite-hub/agent", "@vite-hub/env"],
    dependencies: { evlog: "2.37.1", "posthog-node": "6.0.6" },
    vitehub: () => ({ observability }),
    files: {
      "server/api/primitives/observability.get.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { useObservability } from "vite-hub/agent/observability"

        export default defineEventHandler((event) => {
          const observability = useObservability()
          observability.event("primitive.ping", { probe: String(getQuery(event).probe) })
          return { configured: observability.status().configured }
        })
      `,
    },
    prepare: context => setServerEnv(context, { PRIMITIVE_POSTHOG_KEY: "phc_nuxt_primitives" }),
    async probe({ fetch, mode }) {
      const probe = probeId(mode, "event")
      await expectJson(await fetch(`/api/primitives/observability?probe=${probe}`), { configured: true })
      await eventually(async () => {
        const event = fake.events.find(entry => entry.event === "primitive.ping" && entry.properties.probe === probe)
        expectEqual(`The PostHog event of ${probe}`, event && { probe: event.properties.probe, service: event.properties.service }, { probe, service: "nuxt-primitives" })
      }, 20_000)
    },
  },
  {
    id: "bundle",
    packages: ["@vite-hub/bundle"],
    vitehub: (_target, origin) => ({ ...consoleConfig(origin), bundle: true }),
    files: {},
    async prepare(context) {
      await prepareConsole(context)
      if (context.mode.endsWith("-dev") && !existsSync(join(context.appDir, ".vitehub/bundle"))) {
        await run("pnpm", ["exec", "nuxt", "build"], context.appDir, commandEnv())
      }
    },
    async probe(context) {
      const report = await readBundleReport(context.appDir)
      expectEqual("The bundle report", { client: (report.client?.bytes ?? 0) > 0, schemaVersion: report.schemaVersion, server: (report.server?.bytes ?? 0) > 0 }, { client: true, schemaVersion: 1, server: true })
      if (context.mode.endsWith("-build")) {
        expectEqual("The host of the bundle report", report.host, nitroPreset(context.target))
        const reply = await callConsole(context, "bundle.report")
        expectEqual("bundle.report on a built server", reply.ok ? reply : { code: reply.error.code, status: reply.status }, { code: "BUNDLE_DEV_SERVER_REQUIRED", status: 409 })
        return
      }
      expectEqual("bundle.report on the dev server", await consoleValue(context, "bundle.report"), report)
    },
  },
  {
    id: "device",
    packages: ["@vite-hub/device"],
    vitehub: () => ({ device: { account: false } }),
    files: {
      "app/pages/device.vue": `
        <script setup lang="ts">
        const { data, status, storedAt } = useStoredFetch<{ value: string }>("/api/primitives/device")
        onMounted(() => {
          setDeviceAccount("public")
          Object.assign(window, { primitiveDevice: inspectDevice })
        })
        </script>

        <template>
          <main>
            <p id="value">{{ data?.value ?? "none" }}</p>
            <p id="status">{{ status }}</p>
            <p id="stored">{{ storedAt ? "stored" : "live" }}</p>
          </main>
        </template>
      `,
      "server/api/primitives/device.get.ts": `
        import { defineEventHandler } from "nitro/h3"

        export default defineEventHandler(() => ({ value: "kept by the device" }))
      `,
    },
    async probe({ origin }) {
      const browser = await chromium.launch()
      try {
        await retry(3, async () => {
          const page = await (await browser.newContext()).newPage()
          const messages: string[] = []
          page.on("console", message => messages.push(message.text()))
          page.on("pageerror", error => messages.push(error.message))
          const step = async (label: string, source: string) => {
            await page.waitForFunction(source, undefined, { timeout: 30_000 }).catch(async (error: unknown) => {
              const text = await page.evaluate<string>(`document.body?.innerText ?? ""`).catch(() => "")
              throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}\npage: ${JSON.stringify(text.slice(0, 500))}\nconsole: ${JSON.stringify(messages.slice(-10))}`)
            })
          }
          await page.goto(`${origin}/device`)
          await step("live read", deviceText({ status: "success", stored: "live", value: "kept by the device" }))
          await step("stored entry", `window.primitiveDevice?.().entries.some(entry => entry.key === "/api/primitives/device")`)
          expectEqual("The device storage", await page.evaluate<string>(`window.primitiveDevice().storage`), "indexeddb")
          await page.route("**/api/primitives/device", route => route.abort())
          await page.goto(`${origin}/device`)
          await step("stored read", deviceText({ status: "error", stored: "stored", value: "kept by the device" }))
        })
      }
      finally {
        await browser.close()
      }
    },
  },
  {
    id: "forge",
    packages: ["@vite-hub/forge"],
    files: {
      "server/api/primitives/forge.get.ts": `
        import { defineEventHandler } from "nitro/h3"
        import { useForge } from "vite-hub/forge"

        export default defineEventHandler(async () => {
          const forge = useForge({ forge: "gitea" })
          const [error, provider] = await forge.provider({ repository: "acme/web" })
          if (error) throw error
          const { data, status } = await provider.request("GET", "/repos/acme/web")
          return { auth: forge.auth, kind: forge.kind, repository: data, status }
        })
      `,
    },
    prepare: context => setServerEnv(context, { VITEHUB_GITEA_BASE_URL: fake.origin, VITEHUB_GITEA_TOKEN: "gitea-token" }),
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/forge"), {
        auth: "token",
        kind: "gitea",
        repository: { authorization: "token gitea-token", full_name: "acme/web", path: "/api/v1/repos/acme/web" },
        status: 200,
      })
    },
  },
  {
    id: "shell",
    packages: ["@vite-hub/shell"],
    dependencies: { "just-bash": "3.6.1" },
    files: {
      "server/api/primitives/shell.get.ts": `
        import { InMemoryFs } from "just-bash"
        import { defineEventHandler } from "nitro/h3"
        import { analyzeShellCommand, createShellRuntime } from "vite-hub/shell"
        import { createJustBashDriver } from "vite-hub/shell/providers/just-bash"

        export default defineEventHandler(async () => {
          const command = "cat notes.txt | grep ready"
          const analysis = await analyzeShellCommand(command)
          const fs = Object.assign(new InMemoryFs({ "/workspace/notes.txt": "draft\\nready to ship\\n" }), { writeFs: false })
          const shell = createShellRuntime({
            driver: createJustBashDriver({ commands: ["cat", "grep"], cwd: "/workspace", fs }),
            policy: { maxShellCalls: 1, timeout: 10_000 },
          })
          const { exitCode, stderr, stdout } = await shell.exec(command, { cwd: "/workspace" })
          return { analysis, exitCode, stderr, stdout }
        })
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/shell"), {
        analysis: { commands: ["cat", "grep"], hasCommandSubstitution: false, hasHeredocs: false, hasPipelines: true, hasRedirects: false, ok: true, parser: "sh-syntax" },
        exitCode: 0,
        stderr: "",
        stdout: "ready to ship\n",
      })
    },
  },
  {
    id: "browser",
    packages: ["@vite-hub/browser"],
    vitehub: () => ({ browser: true }),
    files: {
      "server/api/primitives/browser.get.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { runBrowserAction, runBrowserContent } from "vite-hub/browser"

        export default defineEventHandler(async (event) => {
          const url = String(getQuery(event).url)
          const [error, html] = await runBrowserContent(url)
          if (!error) return { rendered: html.includes("Nuxt primitives") }
          // The action answer names the provider error, which the Result leaves out.
          const action = await runBrowserAction("content", url)
          return Response.json({ code: error.code, action: await action.text() }, { status: 502 })
        })
      `,
    },
    prepare: context => setServerEnv(context, { BROWSER_SANDBOX: "false" }),
    async probe({ fetch, origin }) {
      await retry(3, async () => expectJson(await fetch(`/api/primitives/browser?url=${encodeURIComponent(`${origin}/`)}`), { rendered: true }))
    },
  },
]
