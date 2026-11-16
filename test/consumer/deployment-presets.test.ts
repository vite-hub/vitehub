import { existsSync } from "node:fs"
import { execFile as execFileCallback } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build, copyPublicAssets, createNitro, prepare, prerender } from "nitro/builder"
import { nitro } from "nitro/vite"
import { createBuilder, resolveConfig, type Plugin, type PluginOption } from "vite"
import { vitehub } from "vite-hub"
import { expect, it } from "vitest"

import { createCloudflareRateLimitBindings } from "../../packages/rate-limit/src/internal/cloudflare-bindings.ts"

const execFile = promisify(execFileCallback)

function flattenPlugins(options: PluginOption[]): Plugin[] {
  return options.flat(Number.POSITIVE_INFINITY).filter((plugin): plugin is Plugin => Boolean(plugin) && typeof plugin === "object")
}

it("keeps implicit Workflow inert when Agent targets Netlify", () => {
  const names = flattenPlugins(vitehub({ agent: { invocations: false }, host: "netlify" }))
    .map(plugin => plugin.name)

  expect(names).toContain("@vite-hub/agent/vite")
  expect(names).not.toContain("@vite-hub/workflow/vite")
})

it("disables Workflow in the Netlify consumer fixture", async () => {
  const previousHost = process.env.VITEHUB_HOST
  process.env.VITEHUB_HOST = "netlify"
  try {
    const config = (await import("../../fixtures/consumer/vite-hub/vite.config.ts")).default
    if (typeof config === "function" || config instanceof Promise) throw new TypeError("Expected an object Vite config.")
    const plugins = Array.isArray(config.plugins) ? config.plugins.flat(Number.POSITIVE_INFINITY) : []
    const names = plugins
      .filter((plugin): plugin is Exclude<typeof plugin, false | null | undefined> => Boolean(plugin))
      .map(plugin => typeof plugin === "object" && "name" in plugin ? plugin.name : undefined)

    expect(names).toContain("@vite-hub/agent/vite")
    expect(names).toContain("@vite-hub/schedule/vite")
    expect(names).not.toContain("@vite-hub/workflow/vite")
  }
  finally {
    if (previousHost === undefined) delete process.env.VITEHUB_HOST
    else process.env.VITEHUB_HOST = previousHost
  }
})

it("preserves Nitro Netlify output when emitting the ViteHub deployment manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-netlify-output-"))
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
  try {
    await mkdir(join(root, "server/routes"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "netlify-fixture" }), "utf8")
    await writeFile(join(root, "server/routes/index.ts"), 'import { defineHandler } from "nitro/h3"\n\nexport default defineHandler(() => "ok")\n', "utf8")
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        host: "netlify",
        agent: false,
        blob: false,
        database: false,
        env: false,
        queue: false,
        rateLimit: false,
        workflow: false,
        workspace: false,
      })],
    }, "build")
    const nitroConfig = (config as typeof config & { nitro?: Parameters<typeof createNitro>[0] }).nitro
    expect(nitroConfig).toBeDefined()

    nitro = await createNitro({ ...nitroConfig, dev: false, rootDir: root, serverDir: "./server" })
    await prepare(nitro)
    await copyPublicAssets(nitro)
    await prerender(nitro)
    await build(nitro)

    const netlifyDeploymentPath = join(root, ".netlify/deployment.json")
    const missingNetlifyDeploymentOutputs = [
      ".netlify/v1/functions/server/server.mjs",
      "dist/_redirects",
      ".netlify/deployment.json",
    ].filter(path => !existsSync(join(root, path)))
    expect(missingNetlifyDeploymentOutputs, "Netlify must preserve Nitro output and emit the ViteHub deployment manifest").toEqual([])
    await expect(readFile(netlifyDeploymentPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      host: "netlify",
      identity: {
        name: "netlify-fixture",
        source: "package.json",
      },
      output: {
        directory: ".netlify",
        entry: "v1/functions/server/server.mjs",
      },
      runtime: "node",
    })
  } finally {
    try {
      await nitro?.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }
})

it("bundles the Agent AI SDK module into Nitro Cloudflare output", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-ai-cloudflare-output-"))
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
  try {
    await symlink(join(import.meta.dirname, "../../node_modules"), join(root, "node_modules"), "dir")
    await mkdir(join(root, "server/api"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-ai-cloudflare-fixture" }), "utf8")
    const aiSdkRuntime = resolve(import.meta.dirname, "../../packages/agent/src/internal/ai-sdk-runtime.ts")
    await writeFile(join(root, "server/api/agent.get.ts"), [
      'import { defineHandler } from "nitro/h3"',
      `import { loadAiSdk } from ${JSON.stringify(aiSdkRuntime)}`,
      "",
      'export default defineHandler(async () => ["agent-ai-route", typeof (await loadAiSdk()).generateText])',
      "",
    ].join("\n"), "utf8")

    nitro = await createNitro({
      compatibilityDate: "2026-07-20",
      dev: false,
      preset: "cloudflare-module",
      rootDir: root,
      serverDir: "./server",
    })
    await prepare(nitro)
    await copyPublicAssets(nitro)
    await prerender(nitro)
    await build(nitro)

    // Nitro chooses the chunk names, so find the route chunk by the marker in its handler.
    const serverDir = join(root, ".output/server")
    const chunks = await Promise.all((await readdir(serverDir, { recursive: true }))
      .filter(file => file.endsWith(".mjs"))
      .map(async file => ({ path: join(serverDir, file), source: await readFile(join(serverDir, file), "utf8") })))
    const routeChunks = chunks.filter(chunk => chunk.source.includes("agent-ai-route"))
    expect(routeChunks.map(chunk => chunk.path)).toHaveLength(1)
    const { path: route, source: routeSource } = routeChunks[0]!
    const aiSpecifier = routeSource.match(/import\(["']([^"']+)["']\)/)?.[1]
    expect(aiSpecifier).toMatch(/^\.\.?\//)
    expect(existsSync(resolve(dirname(route), aiSpecifier!))).toBe(true)
    // The handler loads the AI SDK from the bundled module, as the Worker does.
    const handler = (await import(pathToFileURL(route).href) as { default: (event: unknown) => Promise<unknown> }).default
    await expect(handler({})).resolves.toEqual(["agent-ai-route", "function"])
  } finally {
    try {
      await nitro?.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }
}, 30_000)

it("derives Cloudflare provider output from the Workers Builds target", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cloudflare-provider-output-"))
  const deploymentName = "vitehub-drop-preview"
  const generatedQueue = `${deploymentName}-image-optimization`
  const manualQueue = "manual-queue"
  const manualBucket = { binding: "MANUAL_BUCKET", bucket_name: "manual-bucket" }
  const manualContainer = { class_name: "ManualContainer", name: "manual-container" }
  const manualRateLimit = { name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }
  const previousProviderName = process.env.WRANGLER_CI_OVERRIDE_NAME
  try {
    process.env.WRANGLER_CI_OVERRIDE_NAME = deploymentName
    await symlink(join(import.meta.dirname, "../../node_modules"), join(root, "node_modules"), "dir")
    await mkdir(join(root, "server/api"), { recursive: true })
    await mkdir(join(root, "server/queues"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "package-default" }), "utf8")
    await writeFile(join(root, "index.html"), "<!doctype html><title>ViteHub</title>\n", "utf8")
    await writeFile(join(root, "server/queues/image-optimization.ts"), [
      'import { defineQueue } from "vite-hub/queue"',
      'export default defineQueue<string>(async () => undefined)',
      '',
    ].join("\n"), "utf8")
    await writeFile(join(root, "server/api/upload.get.ts"), [
      "export default defineEventHandler(async (event) => {",
      '  const { requireRateLimit } = await import("vite-hub/rate-limit")',
      '  await requireRateLimit(event, "image-upload", { failure: "deny", limit: 5, window: "1m" })',
      "  return { ok: true }",
      "})",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "server/api/queue.get.ts"), [
      "export default defineEventHandler(async () => {",
      '  const { deferQueue } = await import("vite-hub/queue")',
      '  deferQueue("image-optimization", "queued")',
      '  return "queued"',
      "})",
      "",
    ].join("\n"), "utf8")
    const builder = await createBuilder({
      nitro: {
        cloudflare: {
          wrangler: {
            containers: [manualContainer],
            queues: {
              consumers: [{ queue: manualQueue }],
              producers: [{ binding: "MANUAL_QUEUE", queue: manualQueue }],
            },
            ratelimits: [manualRateLimit],
            r2_buckets: [manualBucket],
          },
        },
        compatibilityDate: "2026-07-20",
        serverDir: true,
      },
      plugins: [
        vitehub({
          host: "cloudflare",
          agent: false,
          blob: true,
          database: false,
          env: false,
          kv: false,
          queue: true,
          rateLimit: true,
          sandboxTask: true,
          workflow: false,
          workspace: false,
        }),
        nitro(),
      ],
      root,
    })
    await builder.buildApp()

    const generatedRateLimit = createCloudflareRateLimitBindings([{
      name: "image-upload",
      policy: { failure: "deny", limit: 5, window: "1m" },
      source: { column: 3, file: "server/api/upload.get.ts", line: 3 },
    }], deploymentName)[0]
    await expect(readFile(join(root, ".vitehub/rate-limit/manifest.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      rateLimits: [{ name: "image-upload", provider: "cloudflare" }],
    })
    await expect(readFile(join(root, ".output/deployment.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      identity: {
        name: deploymentName,
        source: "WRANGLER_CI_OVERRIDE_NAME",
      },
    })
    await expect(readFile(join(root, ".output/nitro.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      commands: {
        deploy: "npx wrangler deploy --config ./server/wrangler.json --containers-rollout=gradual",
      },
    })
    const wrangler = JSON.parse(await readFile(join(root, ".output/server/wrangler.json"), "utf8"))
    expect(wrangler).toMatchObject({
      containers: expect.arrayContaining([
        manualContainer,
        expect.objectContaining({ name: `${deploymentName}-sandbox` }),
      ]),
      name: deploymentName,
      ratelimits: [
        manualRateLimit,
        generatedRateLimit,
      ],
      r2_buckets: expect.arrayContaining([
        manualBucket,
        { binding: "BLOB", bucket_name: deploymentName },
      ]),
    })
    expect(wrangler.queues?.consumers).toEqual([
      { queue: manualQueue },
      { queue: generatedQueue },
    ])
    expect(wrangler.queues?.producers).toEqual([
      { binding: "MANUAL_QUEUE", queue: manualQueue },
      {
        binding: "QUEUE_696D6167652D6F7074696D697A6174696F6E",
        queue: generatedQueue,
      },
    ])

    const serverRoot = join(root, ".output/server")
    const runtime = (await readdir(serverRoot, { recursive: true }))
      .filter(file => file.endsWith(".mjs"))
      .map(file => readFile(join(serverRoot, file), "utf8"))
    const emittedSource = (await Promise.all(runtime)).join("\n")
    expect(emittedSource).toContain("cloudflare:queue")
    expect(emittedSource).toContain(generatedQueue)
    expect(emittedSource).toContain('requireRateLimit(event, "image-upload"')
    expect(emittedSource).toContain('bindingPrefix = "RATE_LIMIT"')
    // Provider-specific diagnostics may mention the Vercel SDK, but the
    // Cloudflare bundle must not import either Vercel runtime implementation.
    expect(emittedSource).not.toMatch(/(?:from|import\()\s*["']@vercel\/(?:functions|queue)["']/)
    expect(existsSync(join(root, ".vercel/output"))).toBe(false)
  } finally {
    if (typeof previousProviderName === "undefined") delete process.env.WRANGLER_CI_OVERRIDE_NAME
    else process.env.WRANGLER_CI_OVERRIDE_NAME = previousProviderName
    await rm(root, { force: true, recursive: true })
  }
}, 30_000)

it("loads the generated Schedule module and emits each Cloudflare cron once", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vitehub-cloudflare-schedule-output-")))
  const cron = "0 * * * *"
  try {
    await symlink(join(import.meta.dirname, "../../node_modules"), join(root, "node_modules"), "dir")
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "schedule-cloudflare-fixture" }), "utf8")
    await writeFile(join(root, "index.html"), "<!doctype html><title>ViteHub</title>\n", "utf8")
    await writeFile(join(root, "server/schedules/cleanup.ts"), [
      'import { defineSchedule } from "vite-hub/schedule"',
      `export default defineSchedule({ cron: ${JSON.stringify(cron)}, handler: () => undefined })`,
      "",
    ].join("\n"), "utf8")

    const builder = await createBuilder({
      nitro: {
        cloudflare: {
          wrangler: {
            triggers: { crons: [cron] },
          },
        },
        compatibilityDate: "2026-07-20",
        serverDir: true,
      },
      plugins: [
        vitehub({
          host: "cloudflare",
          agent: false,
          blob: false,
          database: false,
          env: false,
          kv: false,
          queue: false,
          rateLimit: false,
          schedule: true,
          workflow: false,
          workspace: false,
        }),
        nitro(),
      ],
      root,
    })
    await builder.buildApp()

    expect(existsSync(join(root, ".vitehub/nitro/schedule/module.mjs"))).toBe(true)
    const wrangler = JSON.parse(await readFile(join(root, ".output/server/wrangler.json"), "utf8"))
    expect(wrangler.triggers?.crons).toEqual([cron])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}, 30_000)

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("uploads and executes native packages when updating an existing Deno app", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-deno-native-update-"))
  const workspaceRoot = resolve(import.meta.dirname, "../..")
  const require = createRequire(join(workspaceRoot, "packages/internal/package.json"))
  const sharpEntry = await realpath(require.resolve("sharp"))
  const sharpRoot = dirname(dirname(sharpEntry))
  // Sharp names its native files by release. Read the names from the installed packages so a dependency refresh keeps this test valid.
  const sharpRequire = createRequire(sharpEntry)
  const sharpAddon = `sharp-linux-x64-${(sharpRequire("@img/sharp-linux-x64/package") as { version: string }).version}.node`
  const libvipsLibrary = basename(sharpRequire.resolve("@img/sharp-libvips-linux-x64/binary"))
  const output = join(root, ".output")
  const remote = await mkdtemp(join(tmpdir(), "vitehub-deno-native-remote-"))
  const bin = join(root, "bin")
  const invocationsFile = join(root, "invocations.jsonl")
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
  try {
    await mkdir(join(root, "node_modules"), { recursive: true })
    await mkdir(join(root, "server/api"), { recursive: true })
    await symlink(sharpRoot, join(root, "node_modules/sharp"), "dir")
    await writeFile(join(root, "server/api/optimize.get.ts"), `import { createRequire } from "node:module"
import { join, relative } from "node:path"
import { defineHandler } from "nitro/h3"
import sharp from "sharp"

const require = createRequire(join(process.cwd(), "server/index.mjs"))

export default defineHandler(async () => {
  const nativePath = require.resolve("@img/" + "sharp-linux-x64/sharp.node")
  if (relative(process.cwd(), nativePath).startsWith("..")) throw new Error("Sharp did not resolve from the uploaded Deno artifact")
  const png = await sharp({ create: { background: "#123456", channels: 4, height: 2, width: 2 } }).png().toBuffer()
  return [...png.subarray(0, 4)]
})
`, "utf8")
    const config = await resolveConfig({
      root,
      // This test builds with Nitro alone, without the Vite resolver that bundles generated plugins into the server.
      // Nitro leaves generated runtime plugins external, so `deno check` follows their ViteHub imports
      // outside the artifact. These plugins do not affect native package uploads.
      plugins: flattenPlugins([vitehub({
        host: "deno",
        agent: false,
        blob: false,
        database: false,
        env: false,
        queue: false,
        rateLimit: false,
        workflow: false,
        workspace: false,
      })]).filter(plugin => plugin.name !== "vite-hub/error-log" && plugin.name !== "vite-hub/standard-context"),
    }, "build")
    const nitroConfig = (config as typeof config & { nitro?: Parameters<typeof createNitro>[0] }).nitro
    expect(nitroConfig).toBeDefined()

    nitro = await createNitro({ ...nitroConfig, dev: false, rootDir: root, serverDir: "./server" })
    await prepare(nitro)
    await copyPublicAssets(nitro)
    await prerender(nitro)
    await build(nitro)

    // Nitro traces Sharp and its native packages into the artifact. Find them as the server entry resolves them.
    const artifactRequire = createRequire(join(output, "server/index.mjs"))
    const nativeFiles = [
      join(dirname(artifactRequire.resolve("@img/sharp-linux-x64/package")), "lib", sharpAddon),
      join(dirname(artifactRequire.resolve("@img/sharp-libvips-linux-x64/package")), "lib", libvipsLibrary),
    ].map(file => relative(output, file))
    for (const file of nativeFiles) {
      expect(file, "Native packages must be inside the Deno artifact").not.toMatch(/^\.\./)
      expect(existsSync(join(output, file)), file).toBe(true)
    }
    const entry = "server/index.mjs"
    expect(existsSync(join(output, entry))).toBe(true)
    expect(existsSync(join(output, "server/index.ts"))).toBe(true)
    await execFile("deno", ["check", entry], { cwd: output, timeout: 30_000 })
    await execFile("deno", ["check", "server/index.ts"], { cwd: output, timeout: 30_000 })
    await mkdir(bin, { recursive: true })
    const fakeDeno = join(bin, "deno")
    await writeFile(fakeDeno, `#!/usr/bin/env node
import { appendFile, cp, mkdir, readdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { join, relative, sep } from "node:path"

const args = process.argv.slice(2)
await appendFile(process.env.VITEHUB_DENO_INVOCATIONS, JSON.stringify(args) + "\\n")
if (args[0] === "deploy" && args[1] === "create") process.exit(1)

const source = process.cwd()
const remote = process.env.VITEHUB_DENO_REMOTE
const includeNodeModules = args.includes("--allow-node-modules")
await rm(remote, { force: true, recursive: true })
await mkdir(remote, { recursive: true })
for (const entry of await readdir(source)) {
  await cp(join(source, entry), join(remote, entry), {
    dereference: true,
    filter: path => includeNodeModules || !relative(source, path).split(sep).includes("node_modules"),
    recursive: true,
  })
}

const probe = ${JSON.stringify(`let handler
Object.defineProperty(Deno, "serve", {
  configurable: true,
  value: (...args) => {
    handler = args.at(-1)
    return { addr: { hostname: "127.0.0.1", port: 0, transport: "tcp" }, finished: Promise.resolve(), ref() {}, shutdown: async () => {}, unref() {} }
  },
})
await import("./" + Deno.env.get("VITEHUB_DENO_ENTRY"))
const response = await handler(new Request("http://localhost/api/optimize"), { remoteAddr: { hostname: "127.0.0.1", port: 1234, transport: "tcp" } })
const signature = await response.json()
if (response.status !== 200 || JSON.stringify(signature) !== "[137,80,78,71]") throw new Error("Generated Deno output did not execute Sharp: " + response.status + " " + JSON.stringify(signature))
Deno.exit(0)
`)}
const result = spawnSync(process.env.VITEHUB_REAL_DENO, ["eval", probe], { cwd: remote, env: process.env, stdio: "inherit" })
process.exit(result.status ?? 1)
`, "utf8")
    await chmod(fakeDeno, 0o755)
    const realDeno = (await execFile("which", ["deno"])).stdout.trim()
    await execFile(process.execPath, [join(output, "deploy.mjs")], {
      env: {
        ...process.env,
        DENO_DEPLOY_APP: "existing-native-app",
        DENO_DEPLOY_ORG: "vitehub",
        PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
        VITEHUB_DENO_ENTRY: "server/index.ts",
        VITEHUB_DENO_INVOCATIONS: invocationsFile,
        VITEHUB_DENO_REMOTE: remote,
        VITEHUB_REAL_DENO: realDeno,
      },
      timeout: 30_000,
    })

    const invocations = (await readFile(invocationsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[])
    expect(invocations).toHaveLength(2)
    expect(invocations[0]!.slice(0, 3)).toEqual(["deploy", "create", "."])
    expect(invocations[1]!.slice(0, 2)).toEqual(["deploy", "."])
    for (const invocation of invocations) expect(invocation).toContain("--allow-node-modules")
    for (const file of nativeFiles) expect(existsSync(join(remote, file)), file).toBe(true)
  } finally {
    try {
      await nitro?.close()
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(remote, { force: true, recursive: true }),
      ])
    }
  }
}, 60_000)
