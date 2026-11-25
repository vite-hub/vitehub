import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { featureIds } from "../../packages/internal/src/features.ts"
import { agents } from "./nuxt-primitives/agents.ts"
import { access } from "./nuxt-primitives/access.ts"
import { content } from "./nuxt-primitives/content.ts"
import { jobs } from "./nuxt-primitives/jobs.ts"
import { ops } from "./nuxt-primitives/ops.ts"
import { isRow, modes, type Mode, type PrimitiveRow, type Target } from "./nuxt-primitives/row.ts"
import { storage } from "./nuxt-primitives/storage.ts"
import {
  availablePort,
  consumerNuxt,
  installApp,
  packWorkspacePackages,
  repoRoot,
  run,
  stopProcessGroup,
  workspaceConfig,
  type PackageManifest,
} from "./packed-app.ts"

const entries = [...storage, ...jobs, ...agents, ...content, ...access, ...ops]
const rows = entries.filter(isRow)
const nuxtVersion = process.env.VITEHUB_CONSUMER_NUXT === "4.7" ? "Nuxt 4.7" : "Nuxt 5 nightly"

const featurePackages: Record<string, string> = { rateLimit: "rate-limit", sandboxTask: "sandbox" }
const notPrimitives: Record<string, string> = {
  cli: "The `vitehub` command, which the Database row runs.",
  docs: "A Nuxt module of its own, `vite-hub/docs/nuxt`, that `vite-hub/nuxt` does not install. It adds Nuxt UI and owns `/sitemap.xml`, `/mcp`, and the trailing-slash rule of the site, so it cannot share the primitives app. packages/docs/test/nuxt-consumer.test.ts builds it in a Nuxt app.",
  codemods: "Rewrites app source before it moves to ViteHub. It adds nothing to a Nuxt app.",
  presets: "Agent presets built from the other primitives.",
  runtime: "The shared error and request contracts of every primitive.",
  ui: "Vue parts that the other primitives render.",
}

async function viteHubFeatureKeys() {
  const manifest = JSON.parse(await readFile(join(repoRoot, "packages/vite-hub/package.json"), "utf8")) as PackageManifest
  const owners = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
    .filter(name => name.startsWith("@vite-hub/"))
    .map(name => name.slice("@vite-hub/".length))
  return [...new Set([...featureIds.map(id => featurePackages[id] ?? id), ...owners])].sort()
}

function nuxtConfig(target: Target, active: PrimitiveRow[]) {
  const vitehub = Object.assign({ agent: false, host: target }, ...active.map(row => row.vitehub?.(target) ?? {}))
  const nitro = target === "cloudflare"
    ? { cloudflare: { deployConfig: true }, preset: "cloudflare_module" }
    : { preset: "node-server" }
  return `export default defineNuxtConfig(${JSON.stringify({ compatibilityDate: "2026-10-01", modules: ["vite-hub/nuxt"], nitro, vitehub }, null, 2)})\n`
}

async function writeAppFiles(appDir: string, files: Record<string, string>) {
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(appDir, path)), { recursive: true })
    await writeFile(join(appDir, path), source)
  }
}

const readyPath = "/api/primitives/harness-ready"
const readyPrefix = "nuxt-primitives-ready:"

async function nitroWorker(origin: string, timeout: number) {
  try {
    const response = await fetch(`${origin}${readyPath}`, { redirect: "manual", signal: AbortSignal.timeout(timeout) })
    const body = await response.text()
    if (response.status === 200 && body.startsWith(readyPrefix)) return body
  }
  catch {
    return undefined
  }
}

async function withServer<T>(command: string, args: string[], cwd: string, ready: RegExp | undefined, callback: (origin: string) => Promise<T>, readySamples = 1) {
  const port = await availablePort()
  const child = spawn(command, args.map(arg => arg.replace("{port}", String(port))), {
    cwd,
    detached: true,
    env: { ...process.env, HOST: "127.0.0.1", NO_COLOR: "1", NUXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""
  child.stdout.on("data", chunk => { logs += String(chunk) })
  child.stderr.on("data", chunk => { logs += String(chunk) })
  const origin = `http://127.0.0.1:${port}`
  try {
    const deadline = Date.now() + 240_000
    while (ready && !ready.test(logs)) {
      if (child.exitCode !== null) throw new Error(`${command} ${args.join(" ")} exited early.\n${logs}`)
      if (Date.now() > deadline) throw new Error(`${command} ${args.join(" ")} did not start.\n${logs}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    let worker: string | undefined
    let samples = 0
    while (samples < readySamples) {
      if (child.exitCode !== null) throw new Error(`${command} ${args.join(" ")} exited early.\n${logs}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`${origin}${readyPath} did not report a stable Nitro worker.\n${logs}`)
      const current = await nitroWorker(origin, Math.min(remaining, 60_000))
      samples = current ? (current === worker ? samples + 1 : 1) : 0
      worker = current
      if (samples === readySamples) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return await callback(origin).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- server output ---\n${logs.slice(-8000)}`, { cause: error })
    })
  }
  finally {
    await stopProcessGroup(child.pid!)
  }
}

describe("Nuxt primitives", () => {
  it("cover every vite-hub/nuxt feature with a row or a written exemption", async () => {
    const ids = entries.map(entry => entry.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index), "primitives listed twice").toEqual([])
    const missing = (await viteHubFeatureKeys()).filter(key => !ids.includes(key) && !(key in notPrimitives))
    expect(missing, "vite-hub/nuxt features without a row or an exemption in test/consumer/nuxt-primitives/").toEqual([])
    for (const row of rows) {
      for (const [mode, reason] of Object.entries(row.exempt ?? {})) {
        expect(modes, `${row.id} exempts an unknown mode`).toContain(mode)
        expect(reason.trim(), `${row.id} exempts ${mode} without a reason`).not.toBe("")
      }
    }
  })

  describe.skipIf(process.env.VITEHUB_CONSUMER_CONTRACT !== "1")(`packed app on ${nuxtVersion}`, () => {
    let root: string
    let appDir: string
    let rowFiles: string[] = []

    async function exec(command: string, args: string[]) {
      await run("pnpm", ["exec", command, ...args], appDir, { ...process.env, CI: "1", NO_COLOR: "1", NUXT_TELEMETRY_DISABLED: "1" })
    }

    async function configure(target: Target, active: PrimitiveRow[]) {
      await rm(join(appDir, ".vitehub/data"), { force: true, recursive: true })
      const files: Record<string, string> = Object.assign({}, ...active.map(row => row.files))
      for (const path of rowFiles) {
        if (!Object.hasOwn(files, path)) await rm(join(appDir, path), { force: true })
      }
      rowFiles = Object.keys(files)
      await writeAppFiles(appDir, { ...files, "nuxt.config.ts": nuxtConfig(target, active) })
    }

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "vite-hub-nuxt-primitives-"))
      appDir = join(root, "app")
      const packDir = join(root, "packs")
      await mkdir(packDir, { recursive: true })
      const packages = new Set(["vite-hub", ...rows.flatMap(row => row.packages)])
      const specs = await packWorkspacePackages(packDir, packages)
      const files: Record<string, string> = {
        "app/app.vue": "<template><main>Nuxt primitives</main></template>\n",
        [`server${readyPath}.get.ts`]: `
          import { defineEventHandler } from "nitro/h3"

          let worker: string | undefined
          export default defineEventHandler(() => worker ??= ${JSON.stringify(readyPrefix)} + crypto.randomUUID())
        `,
        "package.json": JSON.stringify({
          dependencies: {
            ...Object.fromEntries([...packages].map(name => [name, specs[name]])),
            ...Object.assign({}, ...rows.map(row => row.dependencies ?? {})),
            ...consumerNuxt.dependencies,
            vite: consumerNuxt.overrides.vite,
          },
          devDependencies: { "drizzle-kit": "1.0.0-rc.6", wrangler: "4.166.0", ...consumerNuxt.devDependencies },
          packageManager: "pnpm@10.33.0",
          private: true,
          type: "module",
        }, null, 2),
        "pnpm-workspace.yaml": workspaceConfig(specs, consumerNuxt.overrides),
      }
      await writeAppFiles(appDir, files)
      await installApp(appDir, "--no-strict-peer-dependencies")
    }, 900_000)

    afterAll(async () => {
      if (root) await rm(root, { force: true, recursive: true })
    }, 300_000)

    async function serve(mode: Mode, callback: (origin: string) => Promise<void>) {
      if (mode === "node-build") return withServer(process.execPath, [join(appDir, ".output/server/index.mjs")], appDir, undefined, callback)
      if (mode === "cloudflare-build") {
        return withServer("pnpm", ["exec", "wrangler", "dev", "--config", ".output/server/wrangler.json", "--persist-to", ".wrangler/state", "--ip", "127.0.0.1", "--port", "{port}", "--local", "--show-interactive-dev-session=false"], appDir, /Ready on/, callback)
      }
      return withServer("pnpm", ["exec", "nuxt", "dev", "--no-fork", "--host", "127.0.0.1", "--port", "{port}"], appDir, /Ready in|Local:/, callback, 3)
    }

    it.each(modes)(`answers each primitive route in %s`, async (mode) => {
      const target: Target = mode.startsWith("cloudflare") ? "cloudflare" : "node"
      const active = rows.filter(row => !row.exempt?.[mode])
      await configure(target, active)
      if (mode.endsWith("-build")) {
        await rm(join(appDir, ".output"), { force: true, recursive: true })
        await exec("nuxt", ["build"])
      }
      for (const row of active) {
        await row.prepare?.({
          appDir,
          mode,
          vitehub: args => exec("vitehub", args),
          wrangler: args => exec("wrangler", [...args, "--config", ".output/server/wrangler.json", "--persist-to", ".wrangler/state"]),
        })
      }
      const failures: string[] = []
      await serve(mode, async (origin) => {
        for (const row of active) {
          try {
            await row.probe({ appDir, fetch: (path, init) => fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(60_000) }), mode, target })
          }
          catch (error) {
            failures.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (failures.length) throw new Error(`${failures.length} of ${active.length} rows failed in ${mode} on ${nuxtVersion}:\n${failures.join("\n")}`)
      })
    }, 900_000)
  })
})
