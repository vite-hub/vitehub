import { existsSync } from "node:fs"
import { execFile as execFileCallback } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import { build, copyPublicAssets, createNitro, prepare, prerender } from "nitropack/core"
import { resolveConfig } from "vite"
import { vitehub } from "vite-hub"
import { expect, it } from "vitest"

const execFile = promisify(execFileCallback)

it("preserves Nitro Netlify output when emitting the ViteHub deployment manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-netlify-output-"))
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
  try {
    await mkdir(join(root, "server/routes"), { recursive: true })
    await writeFile(join(root, "server/routes/index.ts"), "export default defineEventHandler(() => 'ok')\n", "utf8")
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        preset: "netlify",
        agent: false,
        blob: false,
        database: false,
        devtools: false,
        env: false,
        queue: false,
        rateLimit: false,
        workflow: false,
        workspace: false,
      })],
    }, "build")
    const nitroConfig = (config as typeof config & { nitro?: Parameters<typeof createNitro>[0] }).nitro
    expect(nitroConfig).toBeDefined()

    nitro = await createNitro({ ...nitroConfig, dev: false, rootDir: root })
    await prepare(nitro)
    await copyPublicAssets(nitro)
    await prerender(nitro)
    await build(nitro)

    const netlifyDeploymentPath = join(root, ".netlify/deployment.json")
    const missingNetlifyDeploymentOutputs = [
      ".netlify/functions-internal/server/server.mjs",
      "dist/_redirects",
      ".netlify/deployment.json",
    ].filter(path => !existsSync(join(root, path)))
    expect(missingNetlifyDeploymentOutputs, "Netlify must preserve Nitro output and emit the ViteHub deployment manifest").toEqual([])
    await expect(readFile(netlifyDeploymentPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      host: "netlify",
      output: {
        directory: ".netlify",
        entry: "functions-internal/server/server.mjs",
      },
      preset: "netlify",
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

it("uploads and executes native packages when updating an existing Deno app", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-deno-native-update-"))
  const workspaceRoot = resolve(import.meta.dirname, "../..")
  const require = createRequire(join(workspaceRoot, "packages/internal/package.json"))
  const sharpPackageJson = await realpath(require.resolve("sharp/package.json"))
  const output = join(root, ".output")
  const remote = await mkdtemp(join(tmpdir(), "vitehub-deno-native-remote-"))
  const bin = join(root, "bin")
  const invocationsFile = join(root, "invocations.jsonl")
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
  try {
    await mkdir(join(root, "node_modules"), { recursive: true })
    await mkdir(join(root, "server/api"), { recursive: true })
    await symlink(dirname(sharpPackageJson), join(root, "node_modules/sharp"), "dir")
    await writeFile(join(root, "server/api/optimize.get.ts"), `import { createRequire } from "node:module"
import { join } from "node:path"
import sharp from "sharp"

const require = createRequire(join(process.cwd(), "server/index.ts"))

export default defineEventHandler(async () => {
  const nativePath = require.resolve("@img/" + "sharp-linux-x64/sharp.node")
  if (!nativePath.startsWith(join(process.cwd(), "node_modules"))) throw new Error("Sharp did not resolve from the uploaded Deno artifact")
  const png = await sharp({ create: { background: "#123456", channels: 4, height: 2, width: 2 } }).png().toBuffer()
  return [...png.subarray(0, 4)]
})
`, "utf8")
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        preset: "deno",
        agent: false,
        blob: false,
        database: false,
        devtools: false,
        env: false,
        queue: false,
        rateLimit: false,
        workflow: false,
        workspace: false,
      })],
    }, "build")
    const nitroConfig = (config as typeof config & { nitro?: Parameters<typeof createNitro>[0] }).nitro
    expect(nitroConfig).toBeDefined()

    nitro = await createNitro({
      ...nitroConfig,
      dev: false,
      externals: { trace: false },
      noExternals: false,
      rootDir: root,
      srcDir: join(root, "server"),
    })
    await prepare(nitro)
    await copyPublicAssets(nitro)
    await prerender(nitro)
    await build(nitro)

    expect(existsSync(join(output, "node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"))).toBe(true)
    expect(existsSync(join(output, "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"))).toBe(true)
    const entry = existsSync(join(output, "server/index.ts")) ? "server/index.ts" : "server/index.mjs"
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
        VITEHUB_DENO_ENTRY: entry,
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
    expect(existsSync(join(remote, "node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node"))).toBe(true)
    expect(existsSync(join(remote, "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3"))).toBe(true)
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
