import { existsSync } from "node:fs"
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, describe, expect, it, vi } from "vitest"
import { build } from "vite"

import { hubBlob } from "../../blob/src/vite.ts"
import { generateProviderOutputs } from "../src/internal/vite-build.ts"
import { hubQueue } from "../src/vite.ts"

import type { writeProviderDeploymentOutputs as WriteProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"

type ProviderOutputWriter = typeof WriteProviderDeploymentOutputs

const providerOutputHooks = vi.hoisted(() => ({
  actualWrite: undefined as ProviderOutputWriter | undefined,
  beforeWrite: undefined as ((options: Parameters<ProviderOutputWriter>[0]) => Promise<void>) | undefined,
}))

vi.mock("@vite-hub/internal/build/deployment-output", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/internal/build/deployment-output")>()
  providerOutputHooks.actualWrite = actual.writeProviderDeploymentOutputs
  return {
    ...actual,
    writeProviderDeploymentOutputs: async (options: Parameters<ProviderOutputWriter>[0]) => {
      await providerOutputHooks.beforeWrite?.(options)
      return actual.writeProviderDeploymentOutputs(options)
    },
  }
})

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []

function resolvePlaygroundNodeModules() {
  const nodeModules = join(playgroundDir, "node_modules")
  return existsSync(nodeModules) ? nodeModules : resolve(playgroundDir, "../../node_modules")
}

function createDefaultCloudflareOutputRoot(rootDir: string) {
  const appName = basename(rootDir).replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase()
  return join(rootDir, "dist", appName)
}

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  const workspacePackagesDir = resolve(playgroundDir, "../../packages")
  await mkdir(baseDir, { recursive: true })
  if (!existsSync(join(baseDir, "packages"))) {
    await symlink(workspacePackagesDir, join(baseDir, "packages"), "dir")
  }
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

async function createPlaygroundCopy(prefix: string) {
  const workspaceDir = await createWorkspaceTempDir(prefix)
  const rootDir = join(workspaceDir, "vite")
  const nodeModules = resolvePlaygroundNodeModules()

  await mkdir(rootDir, { recursive: true })
  await cp(resolve(playgroundDir, "../_shared"), join(workspaceDir, "_shared"), { recursive: true })
  await cp(join(playgroundDir, "build"), join(rootDir, "build"), { recursive: true })
  await cp(join(playgroundDir, "package.json"), join(rootDir, "package.json"))
  await cp(join(playgroundDir, "vite.config.ts"), join(rootDir, "vite.config.ts"))
  await cp(join(playgroundDir, "src"), join(rootDir, "src"), { recursive: true })
  await cp(join(playgroundDir, "server"), join(rootDir, "server"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")

  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-queue-vite-playground-")

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: process.env,
    })

    const cloudflareWorker = join(rootDir, "dist", "vite", "index.js")
    const cloudflareConfig = join(rootDir, "dist", "vite", "wrangler.json")
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const vercelConsumer = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", "index.mjs")
    const vercelConsumerConfig = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", ".vc-config.json")
    const vercelConsumerSource = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", "index.source.mjs")
    const vercelStatic = join(rootDir, ".vercel", "output", "static")
    const vercelConsumerContents = await readFile(vercelConsumer, "utf8")
    const vercelServerContents = await readFile(vercelServer, "utf8")
    const vercelConsumerTrigger = JSON.parse(await readFile(vercelConsumerConfig, "utf8")).experimentalTriggers?.[0]

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(await readFile(cloudflareWorker, "utf8")).toContain("vitehub-queue-worker")
    expect(await readFile(cloudflareConfig, "utf8")).not.toContain("\"run_worker_first\"")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(existsSync(vercelConsumer)).toBe(true)
    expect(existsSync(vercelConsumerConfig)).toBe(true)
    expect(existsSync(vercelConsumerSource)).toBe(false)
    expect(vercelConsumerContents).toContain("waitUntil")
    expect(vercelConsumerContents).not.toContain("runWithQueueRuntimeEvent({ req, res },")
    expect(vercelConsumerContents).toContain("__vitehubVercelQueue")
    expect(vercelConsumerContents).toContain("@vercel/queue")
    expect(vercelConsumerContents).toContain("createVercelQueueRuntimeClient")
    expect(vercelConsumerContents).not.toContain("createCloudflareQueueRuntimeClient")
    expect(vercelConsumerContents).toContain("reportQueueMarker")
    expect(vercelServerContents).toContain("/api/tests/queue")
    expect(vercelServerContents).toContain("globalThis.__vitehubVercelQueue =")
    expect(vercelServerContents).not.toContain("createCloudflareQueueRuntimeClient")
    expect(vercelConsumerTrigger).toEqual({
      consumer: "api_Svitehub_Squeues_Svercel_Swelcome-email_Swelcome-email_Dfunc",
      topic: "topic--77656c636f6d652d656d61696c",
      type: "queue/v2beta",
    })
    expect(existsSync(vercelStatic)).toBe(false)
  }, 15_000)

  it("skips Vercel queue functions when queue support is disabled", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-disabled-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await mkdir(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "stale", "stale.func"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "stale", "stale.func", "index.mjs"), "export default {}\n", "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist/client",
      queue: false,
      rootDir,
    })

    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"))).toBe(true)
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel"))).toBe(false)
  })

  it("copies Vercel static output from Vite's default dist directory", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-default-dist-")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const staleWranglerStaticPath = join(rootDir, ".vercel", "output", "static", relative(join(rootDir, "dist"), cloudflareOutputRoot), "wrangler.json")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      queues: {
        consumers: [{ queue: "stale" }],
        producers: [{ binding: "STALE_QUEUE", queue: "stale" }],
      },
    }, null, 2)}\n`, "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: { provider: "vercel" },
      rootDir,
    })

    expect(await readFile(join(rootDir, ".vercel", "output", "static", "index.html"), "utf8")).toContain("<title>vitehub</title>")
    expect(existsSync(join(rootDir, ".vitehub", "queue", "cloudflare-worker.mjs"))).toBe(false)
    expect(existsSync(join(cloudflareOutputRoot, "wrangler.json"))).toBe(false)
    expect(existsSync(staleWranglerStaticPath)).toBe(false)
    const vercelEntry = await readFile(join(rootDir, ".vitehub", "queue", "vercel-server.mjs"), "utf8")
    expect(vercelEntry).toContain("internal/runtime/vercel-vite")
    expect(vercelEntry).not.toContain("/src/runtime/vercel-vite")
    expect(vercelEntry).not.toContain("/dist/runtime/vercel-vite")
    const vercelServerContents = await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(vercelServerContents).toContain("globalThis.__vitehubVercelQueue =")
  })

  it("preserves shared Cloudflare output during Vercel queue cleanup", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-shared-cloudflare-")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      queues: {
        consumers: [{ queue: "stale" }],
        producers: [{ binding: "STALE_QUEUE", queue: "stale" }],
      },
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`, "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: { provider: "vercel" },
      rootDir,
    })

    await expect(readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      triggers: { crons: ["0 0 * * *"] },
    })
    expect(existsSync(join(rootDir, ".vercel", "output", "static", basename(rootDir), "wrangler.json"))).toBe(false)
  })

  it("cleans a Queue-owned Cloudflare Worker when Queue is disabled under Nitro", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-nitro-cloudflare-")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(cloudflareOutputRoot, "index.js"), "// vitehub-queue-worker\nexport default {}\n", "utf8")
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      compatibility_date: "2026-04-20",
      main: "index.js",
      observability: { enabled: true },
      queues: { producers: [{ binding: "STALE", queue: "stale" }] },
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`, "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      queue: false,
      rootDir,
    })

    expect(existsSync(join(cloudflareOutputRoot, "index.js"))).toBe(false)
    expect(existsSync(join(rootDir, ".vitehub", "queue", "cloudflare-output.json"))).toBe(false)
    await expect(readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("cleans standalone Queue output created before worker banners", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-legacy-nitro-cloudflare-")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: { provider: "cloudflare" },
      rootDir,
    })
    const workerFile = join(cloudflareOutputRoot, "index.js")
    const legacyWorker = [
      "createQueueCloudflareWorker({",
      "getCloudflareQueueDefinitionName(batch.queue)",
      'label: "queue"',
      "",
    ].join("\n")
    expect(legacyWorker).not.toContain("vitehub-queue-worker")
    await writeFile(workerFile, legacyWorker, "utf8")
    const wranglerFile = join(cloudflareOutputRoot, "wrangler.json")
    const wrangler = JSON.parse(await readFile(wranglerFile, "utf8")) as Record<string, unknown>
    await writeFile(wranglerFile, `${JSON.stringify({ ...wrangler, triggers: { crons: ["0 0 * * *"] } }, null, 2)}\n`, "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      queue: { provider: "cloudflare" },
      rootDir,
    })

    expect(existsSync(workerFile)).toBe(false)
    await expect(readFile(wranglerFile, "utf8").then(JSON.parse)).resolves.toEqual({
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("preserves another primitive's Cloudflare Worker during Nitro takeover", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-shared-nitro-cloudflare-")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    for (const worker of ["// workflow worker\n", "// vitehub-blob-worker\n", "export default { fetch() {} }\n"]) {
      await writeFile(join(cloudflareOutputRoot, "index.js"), worker, "utf8")
      await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
        compatibility_flags: ["nodejs_compat"],
        main: "index.js",
        observability: { enabled: true },
        queues: { producers: [{ binding: "STALE", queue: "stale" }] },
        workflows: [{ binding: "WORKFLOW", class_name: "Workflow" }],
      }, null, 2)}\n`, "utf8")

      await generateProviderOutputs({
        clientOutDir: "dist",
        cloudflareOwnedByNitro: true,
        queue: { provider: "cloudflare" },
        rootDir,
      })

      await expect(readFile(join(cloudflareOutputRoot, "index.js"), "utf8")).resolves.toBe(worker)
      await expect(readFile(join(cloudflareOutputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
        compatibility_flags: ["nodejs_compat"],
        main: "index.js",
        observability: { enabled: true },
        queues: { producers: [{ binding: "STALE", queue: "stale" }] },
        workflows: [{ binding: "WORKFLOW", class_name: "Workflow" }],
      })
    }
  })

  it("preserves a Nitro Cloudflare Worker during legacy Queue cleanup", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-nitro-worker-")
    const cloudflareOutputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(cloudflareOutputRoot, { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    const worker = [
      "createQueueCloudflareWorker({",
      "getCloudflareQueueDefinitionName(batch.queue)",
      'label: "queue"',
      'nitro.hooks.hook("cloudflare:queue", () => {})',
    ].join("\n")
    await writeFile(join(cloudflareOutputRoot, "index.js"), worker, "utf8")
    await writeFile(join(cloudflareOutputRoot, "wrangler.json"), `${JSON.stringify({
      compatibility_flags: ["nodejs_compat"],
      main: "index.js",
      observability: { enabled: true },
      queues: { producers: [{ binding: "QUEUE", queue: "queue" }] },
    }, null, 2)}\n`, "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      queue: { provider: "cloudflare" },
      rootDir,
    })

    await expect(readFile(join(cloudflareOutputRoot, "index.js"), "utf8")).resolves.toBe(worker)
  })

  it("preserves current Nitro Queue bindings after another primitive replaces the Worker", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-shared-worker-")
    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await generateProviderOutputs({ clientOutDir: "dist", queue: { provider: "cloudflare" }, rootDir })
    await writeFile(join(outputRoot, "index.js"), "// workflow worker\n", "utf8")

    await generateProviderOutputs({ clientOutDir: "dist", cloudflareOwnedByNitro: true, queue: { provider: "cloudflare" }, rootDir })

    await expect(readFile(join(outputRoot, "index.js"), "utf8")).resolves.toBe("// workflow worker\n")
    expect(await readFile(join(outputRoot, "wrangler.json"), "utf8").then(JSON.parse)).toHaveProperty("queues")
  })

  it("preloads Vercel queue for direct clients without queue definitions", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-no-definitions-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: {},
      rootDir,
    })

    const vercelServerContents = await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(vercelServerContents).toContain("globalThis.__vitehubVercelQueue =")
    expect(vercelServerContents).toContain("@vercel/queue")
  })

  it("dispatches from one generated Vercel callback to another Queue", { timeout: 90_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-vercel-nested-dispatch-")
    const standaloneDir = await mkdtemp(join(tmpdir(), "vitehub-queue-vercel-nested-dispatch-standalone-"))
    tempDirs.push(standaloneDir)
    const entry = join(rootDir, "src", "server.ts")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "server", "queues"), { recursive: true })
    await writeFile(join(rootDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8")
    await writeFile(entry, "export default async () => new Response('ok')\n", "utf8")
    await writeFile(join(rootDir, "server", "queues", "source.ts"), [
      "import { runQueue } from '@vite-hub/queue'",
      "export default { handler: async () => {",
      "  await runQueue('target', { nested: true })",
      "} }",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(rootDir, "server", "queues", "target.ts"), "export default { handler: async () => undefined }\n", "utf8")

    await build({
      appType: "custom",
      build: {
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "server.mjs" },
        },
        ssr: entry,
      },
      configFile: false,
      logLevel: "silent",
      nitro: { preset: "vercel" },
      plugins: [hubQueue()],
      queue: { provider: "vercel" },
      root: rootDir,
    } as never)

    const callbackFunctionDir = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "source", "source.func")
    const callbackFunction = join(callbackFunctionDir, "index.mjs")
    const callbackContents = await readFile(callbackFunction, "utf8")
    expect(callbackContents).toContain("createVercelQueueRuntimeClient")
    expect(callbackContents).not.toContain("createCloudflareQueueRuntimeClient")

    await cp(callbackFunctionDir, standaloneDir, { recursive: true })
    const handler = (await import(`${pathToFileURL(join(standaloneDir, "index.mjs")).href}?t=${Date.now()}`)).default
    ;(globalThis as Record<string, unknown>).__vitehubVercelQueue = {
      handleCallback: (callback: (payload: unknown, metadata: unknown) => Promise<void>) => async () => {
        await callback({ source: true }, { deliveryCount: 1, messageId: "source-message" })
        return new Response("handled")
      },
      send: async (topic: string, payload: unknown, options: unknown) => {
        ;(globalThis as Record<string, unknown>).__vitehubNestedQueueDispatch = { options, payload, topic }
        return { messageId: "nested-message" }
      },
    }
    const server = createServer(handler)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing Queue callback address.")
      const response = await fetch(`http://127.0.0.1:${address.port}`, { method: "POST" })
      expect(await response.text()).toBe("handled")
      expect((globalThis as Record<string, unknown>).__vitehubNestedQueueDispatch).toMatchObject({
        payload: { nested: true },
        topic: "topic--746172676574",
      })
    }
    finally {
      server.close()
      await once(server, "close")
      delete (globalThis as Record<string, unknown>).__vitehubNestedQueueDispatch
      delete (globalThis as Record<string, unknown>).__vitehubVercelQueue
    }
  })

  it("composes contributed runtimes into isolated Vercel callbacks", { timeout: 90_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-vercel-runtime-contribution-")
    const standaloneDir = await mkdtemp(join(tmpdir(), "vitehub-queue-vercel-runtime-contribution-standalone-"))
    tempDirs.push(standaloneDir)
    const runtimeFacade = join(rootDir, "runtime-facade.mjs")
    await mkdir(join(rootDir, "server", "queues"), { recursive: true })
    await writeFile(join(rootDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8")
    await writeFile(runtimeFacade, [
      "export async function runSandbox(name, payload) {",
      "  return { name, payload, registry: 'contributed' }",
      "}",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(rootDir, "server", "queues", "sandbox.ts"), [
      "import { runSandbox } from 'vite-hub/sandbox'",
      "export default { handler: async () => {",
      "  globalThis.__vitehubQueueSandboxResult = await runSandbox('image-optimizer', { queued: true })",
      "} }",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      providerImportAliases: { "vite-hub/sandbox": runtimeFacade },
      queue: { provider: "vercel" },
      rootDir,
    })

    const callbackFunctionDir = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "sandbox", "sandbox.func")
    const callbackFunction = join(callbackFunctionDir, "index.mjs")
    await cp(callbackFunctionDir, standaloneDir, { recursive: true })
    const handler = (await import(`${pathToFileURL(join(standaloneDir, "index.mjs")).href}?t=${Date.now()}`)).default
    ;(globalThis as Record<string, unknown>).__vitehubVercelQueue = {
      handleCallback: (callback: (payload: unknown, metadata: unknown) => Promise<void>) => async () => {
        await callback({ queued: true }, { deliveryCount: 1, messageId: "sandbox-message" })
        return new Response("handled")
      },
      send: async () => ({ messageId: "unused" }),
    }
    const server = createServer(handler)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing Queue callback address.")
      const response = await fetch(`http://127.0.0.1:${address.port}`, { method: "POST" })
      expect(await response.text()).toBe("handled")
      expect((globalThis as Record<string, unknown>).__vitehubQueueSandboxResult).toEqual({
        name: "image-optimizer",
        payload: { queued: true },
        registry: "contributed",
      })
      await expect(readFile(callbackFunction, "utf8")).resolves.toContain("registry: \"contributed\"")
    }
    finally {
      server.close()
      await once(server, "close")
      delete (globalThis as Record<string, unknown>).__vitehubQueueSandboxResult
      delete (globalThis as Record<string, unknown>).__vitehubVercelQueue
    }
  })

  it("keeps Cloudflare platform modules external in contributed runtimes", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-cloudflare-platform-runtime-")
    const runtimeFacade = join(rootDir, "runtime-facade.mjs")
    await mkdir(join(rootDir, "server", "queues"), { recursive: true })
    await writeFile(join(rootDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8")
    await writeFile(runtimeFacade, [
      "import { env } from 'cloudflare:workers'",
      "export function runSandbox(name) {",
      "  return { hasEnvironment: Boolean(env), name }",
      "}",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(rootDir, "server", "queues", "sandbox.ts"), [
      "import { runSandbox } from 'vite-hub/sandbox'",
      "export default { handler: async () => runSandbox('image-optimizer') }",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      providerImportAliases: { "vite-hub/sandbox": runtimeFacade },
      queue: { provider: "cloudflare" },
      rootDir,
    })

    const output = join(createDefaultCloudflareOutputRoot(rootDir), "index.js")
    await expect(readFile(output, "utf8")).resolves.toContain("cloudflare:workers")
  })

  it("closes composed Blob runtimes inside isolated Vercel queue functions", { timeout: 90_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-vercel-blob-runtime-")
    const standaloneDir = await mkdtemp(join(tmpdir(), "vitehub-queue-vercel-blob-standalone-"))
    tempDirs.push(standaloneDir)
    const entry = join(rootDir, "src", "server.ts")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "server", "queues"), { recursive: true })
    await mkdir(join(rootDir, "node_modules", "@vite-hub"), { recursive: true })
    await symlink(resolve(import.meta.dirname, "../../blob"), join(rootDir, "node_modules", "@vite-hub", "blob"), "dir")
    await writeFile(join(rootDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8")
    await writeFile(entry, "export default async () => new Response('ok')\n", "utf8")
    await writeFile(join(rootDir, "server", "queues", "blob.ts"), [
      "import { blob } from '@vite-hub/blob'",
      "delete process.env.BLOB_READ_WRITE_TOKEN",
      "const [blobError] = await blob.get('queued-object')",
      "if (blobError?.cause && typeof blobError.cause === 'object' && 'code' in blobError.cause && blobError.cause.code === 'ERR_MODULE_NOT_FOUND') throw blobError.cause",
      "const [gcsOperationError] = await blob.store('backup').list()",
      "const gcsCause = gcsOperationError?.cause",
      "if (gcsCause && typeof gcsCause === 'object' && 'code' in gcsCause && gcsCause.code === 'ERR_MODULE_NOT_FOUND') throw gcsCause",
      "const gcsError = gcsCause instanceof Error ? gcsCause.message : String(gcsCause)",
      "if (!gcsError?.includes('missing bucket')) throw new Error(`Expected the GCS driver to load before validation, received: ${gcsError}`)",
      "globalThis.__vitehubQueueBlobRuntimeLoaded = true",
      "export default { handler: async () => undefined }",
      "",
    ].join("\n"), "utf8")

    await build({
      appType: "custom",
      blob: {
        stores: {
          default: { access: "private", driver: "vercel-blob" },
          archive: {
            accessKeyId: "test-access-key",
            accountId: "test-account",
            bucketName: "test-bucket",
            driver: "cloudflare-r2",
            secretAccessKey: "test-secret-key",
          },
          backup: { bucket: "", driver: "gcs" },
        },
      },
      build: {
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "server.mjs" },
        },
        ssr: entry,
      },
      configFile: false,
      logLevel: "silent",
      nitro: { preset: "vercel" },
      plugins: [hubQueue(), hubBlob()],
      queue: { provider: "vercel" },
      root: rootDir,
    } as never)

    const functionsRoot = join(rootDir, ".vercel", "output", "functions")
    const queueFunction = join(functionsRoot, "__queue.func", "index.mjs")
    const callbackFunctionDir = join(functionsRoot, "api", "vitehub", "queues", "vercel", "blob", "blob.func")
    const callbackFunction = join(callbackFunctionDir, "index.mjs")
    const [queueContents, callbackContents] = await Promise.all([
      readFile(queueFunction, "utf8"),
      readFile(callbackFunction, "utf8"),
    ])
    for (const contents of [queueContents, callbackContents]) {
      expect(contents).toContain("__vitehubQueueBlobRuntimeLoaded")
      expect(contents).not.toMatch(/(?:from\s+|import\s*\()["']@vite-hub\/blob\/drivers\//)
    }
    for (const functionDir of [join(functionsRoot, "__queue.func"), callbackFunctionDir]) {
      expect(existsSync(join(functionDir, "node_modules", "@vite-hub", "blob", "package.json"))).toBe(true)
      expect(existsSync(join(functionDir, "node_modules", "files-sdk", "package.json"))).toBe(false)
      expect(existsSync(join(functionDir, "node_modules", "@aws-sdk", "client-s3", "package.json"))).toBe(false)
      expect(existsSync(join(functionDir, "node_modules", "@google-cloud", "storage", "package.json"))).toBe(false)
      expect(existsSync(join(functionDir, "node_modules", "@azure", "storage-blob", "package.json"))).toBe(false)
    }

    await cp(callbackFunctionDir, standaloneDir, { recursive: true })
    const handler = (await import(`${pathToFileURL(join(standaloneDir, "index.mjs")).href}?t=${Date.now()}`)).default
    ;(globalThis as Record<string, unknown>).__vitehubVercelQueue = {
      handleCallback: (callback: (payload: unknown, metadata: unknown) => Promise<void>) => async () => {
        await callback({}, { deliveryCount: 1, messageId: "blob-message" })
        return new Response("handled")
      },
      send: async () => ({ messageId: "unused" }),
    }
    const server = createServer(handler)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing Queue callback address.")
      await fetch(`http://127.0.0.1:${address.port}`, { method: "POST" })
      expect((globalThis as Record<string, unknown>).__vitehubQueueBlobRuntimeLoaded).toBe(true)
    }
    finally {
      server.close()
      await once(server, "close")
      delete (globalThis as Record<string, unknown>).__vitehubQueueBlobRuntimeLoaded
      delete (globalThis as Record<string, unknown>).__vitehubVercelQueue
    }
  })

  it("does not preload or emit Vercel queue functions when queue config is omitted", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-omitted-provider-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: undefined,
      rootDir,
    })

    const vercelServerContents = await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(vercelServerContents).not.toContain("@vercel/queue")
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel"))).toBe(false)
  })

  it("does not preload or emit Vercel output for a non-Vercel queue provider", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-cloudflare-provider-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")

    await generateProviderOutputs({ clientOutDir: "dist", queue: { provider: "vercel" }, rootDir })
    await rm(join(rootDir, ".vitehub", "queue", "vercel-output.json"))

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: { provider: "cloudflare" },
      rootDir,
    })

    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"))).toBe(false)
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel"))).toBe(false)
  })

  it("removes only the Vercel function recorded as Queue-owned across output modes", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-vercel-ownership-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")

    await generateProviderOutputs({ clientOutDir: "dist", queue: { provider: "vercel" }, rootDir })
    const functionsRoot = join(rootDir, ".vercel", "output", "functions")
    expect(existsSync(join(functionsRoot, "__server.func"))).toBe(true)

    const nitroServer = "export default { nitro: true }\n"
    await writeFile(join(functionsRoot, "__server.func", "index.mjs"), nitroServer, "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      queue: { provider: "vercel" },
      rootDir,
      serverFunctionName: "__queue.func",
    })
    await expect(readFile(join(functionsRoot, "__server.func", "index.mjs"), "utf8")).resolves.toBe(nitroServer)
    expect(existsSync(join(functionsRoot, "__queue.func"))).toBe(true)

    await mkdir(join(functionsRoot, "__server.func"), { recursive: true })
    await writeFile(join(functionsRoot, "__server.func", "index.mjs"), "export default { nitro: true }\n", "utf8")
    await generateProviderOutputs({ clientOutDir: "dist", queue: { provider: "cloudflare" }, rootDir })
    expect(existsSync(join(functionsRoot, "__queue.func"))).toBe(false)
    expect(existsSync(join(functionsRoot, "__server.func", "index.mjs"))).toBe(true)
  })

  it("verifies Queue ownership after a serialized Vercel writer reuses the function", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-vercel-concurrent-ownership-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")

    await generateProviderOutputs({ clientOutDir: "dist", queue: { provider: "vercel" }, rootDir })
    const foreignEntry = join(rootDir, "foreign-server.mjs")
    await writeFile(foreignEntry, "export default { foreign: true }\n", "utf8")

    let intercepted = false
    providerOutputHooks.beforeWrite = async (options) => {
      if (intercepted || !options.cleanup?.cloudflare) return
      intercepted = true
      await providerOutputHooks.actualWrite?.({
        clientOutDir: "dist",
        rootDir,
        vercel: {
          bundleEntry: foreignEntry,
          bundleOptions: { format: "esm", platform: "node" },
        },
      })
    }
    try {
      await generateProviderOutputs({
        clientOutDir: "dist",
        cloudflareOwnedByNitro: true,
        queue: { provider: "vercel" },
        rootDir,
        serverFunctionName: "__queue.func",
      })
    }
    finally {
      providerOutputHooks.beforeWrite = undefined
    }

    const functionsRoot = join(rootDir, ".vercel", "output", "functions")
    await expect(readFile(join(functionsRoot, "__server.func", "index.mjs"), "utf8")).resolves.toContain("foreign")
    expect(existsSync(join(functionsRoot, "__server.func", ".vitehub-queue-output.json"))).toBe(false)
    expect(existsSync(join(functionsRoot, "__queue.func", ".vitehub-queue-output.json"))).toBe(true)
    await expect(readFile(join(rootDir, ".vitehub", "queue", "vercel-output.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      serverFunctionName: "__queue.func",
    })
  })

  it("uses an inferred Cloudflare prefix in standalone bindings and dispatch", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-prefix-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src", "welcome.queue.ts"), "export default null\n", "utf8")

    await generateProviderOutputs({
      clientOutDir: "dist",
      queue: { namePrefix: "preview-" } as never,
      rootDir,
    })

    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const wrangler = JSON.parse(await readFile(join(outputRoot, "wrangler.json"), "utf8"))
    expect(wrangler.queues).toEqual({
      consumers: [{ queue: "preview-queue--77656c636f6d65" }],
      producers: [{ binding: "QUEUE_77656C636F6D65", queue: "preview-queue--77656c636f6d65" }],
    })
    const workerEntry = await readFile(join(rootDir, ".vitehub", "queue", "cloudflare-worker.mjs"), "utf8")
    expect(workerEntry).toContain("internal/runtime/cloudflare-vite")
    expect(workerEntry).not.toContain("/src/runtime/cloudflare-vite")
    expect(workerEntry).not.toContain("/dist/runtime/cloudflare-vite")
    expect(workerEntry).toContain('"preview-queue--77656c636f6d65": "welcome"')
    expect(workerEntry).toContain("definitions: queueDefinitions")
  })

  it("throws when queue names collide after Vercel sanitization", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-queue-vite-collision-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "foo.bar.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "src", "foo+bar.queue.ts"), "export default null\n", "utf8")

    await expect(generateProviderOutputs({
      clientOutDir: "dist/client",
      queue: {},
      rootDir,
    })).rejects.toThrow(/collide after Vercel output sanitization/)
  })
})
