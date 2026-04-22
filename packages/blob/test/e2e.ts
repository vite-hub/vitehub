import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import assert from "node:assert/strict"

import { FetchError, ofetch } from "ofetch"

import { execCommand, getFreePort, startCommand } from "./helpers/http.ts"

type Provider = "cloudflare" | "vercel"
type Framework = "nitro" | "vite"

const PROVIDERS = ["cloudflare", "vercel"] as const
const FRAMEWORKS = ["nitro", "vite"] as const
const workspaceRoot = resolve(import.meta.dirname, "../../..")
const vercelServer = resolve(import.meta.dirname, "helpers/vercel-server.ts")
const nitroBuildScript = [
  'import { build, createNitro, prepare } from "nitro/builder"',
  "const [rootDir, preset] = process.argv.slice(1)",
  "const nitro = await createNitro({ rootDir, preset })",
  "await prepare(nitro)",
  "await build(nitro)",
  "await nitro.close()",
].join("; ")
const dir = (framework: Framework) => resolve(workspaceRoot, "playground", framework)
const log = (message: string) => console.log(`[blob e2e] ${message}`)

let packagesBuiltPromise: Promise<void> | undefined

async function waitForHttp(baseURL: string) {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await ofetch("/", { baseURL })
      return
    }
    catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  throw lastError
}

async function dumpChild(child: Awaited<ReturnType<typeof startCommand>>, label: string, error: unknown) {
  const code = await Promise.race([child.exit, new Promise<number>(resolve => setTimeout(() => resolve(-1), 100))])
  throw new Error([
    `${label} failed (exit: ${code})`,
    String(error),
    `stdout:\n${child.stdout.join("")}`,
    `stderr:\n${child.stderr.join("")}`,
  ].join("\n\n"))
}

async function assertBlobRoundtrip(baseURL: string) {
  const pathname = `notes/e2e-${Date.now().toString(36)}.txt`
  const body = `hello-${Math.random().toString(36).slice(2, 8)}`

  const put = await ofetch("/api/blob", {
    baseURL,
    body: { pathname, value: body },
    method: "PUT",
  })
  assert.equal(put.pathname, pathname)

  const list = await ofetch("/api/blob", { baseURL }) as { blobs: Array<{ pathname: string }> }
  assert.ok(list.blobs.some(blob => blob.pathname === pathname))

  const head = await ofetch("/api/blob/head", {
    baseURL,
    query: { pathname },
  }) as { pathname: string }
  assert.equal(head.pathname, pathname)

  const get = await ofetch("/api/blob/body", {
    baseURL,
    query: { pathname },
  }) as { ok: boolean, text: string | null }
  assert.deepEqual(get, { ok: true, text: body })

  const served = await fetch(new URL(`/api/blob/serve?pathname=${encodeURIComponent(pathname)}`, baseURL))
  assert.equal(served.status, 200)
  assert.equal(await served.text(), body)

  await ofetch("/api/blob", {
    baseURL,
    body: { pathname },
    method: "DELETE",
  })

  try {
    await ofetch("/api/blob/head", {
      baseURL,
      query: { pathname },
    })
    throw new Error("Expected deleted blob lookup to fail.")
  }
  catch (error) {
    assert.ok(error instanceof FetchError)
  }
}

async function ensurePlaygroundPackagesBuilt() {
  packagesBuiltPromise ||= Promise.all([
    execCommand("pnpm", ["--filter", "@vitehub/blob", "build"], { cwd: workspaceRoot, env: process.env }),
    execCommand("pnpm", ["--filter", "@vitehub/kv", "build"], { cwd: workspaceRoot, env: process.env }),
    execCommand("pnpm", ["--filter", "@vitehub/queue", "build"], { cwd: workspaceRoot, env: process.env }),
  ]).then(() => undefined)
  await packagesBuiltPromise
}

async function build(framework: Framework, provider: Provider) {
  await ensurePlaygroundPackagesBuilt()
  const env = {
    ...process.env,
    ...(provider === "cloudflare"
      ? {
          BLOB_BUCKET_NAME: process.env.BLOB_BUCKET_NAME || "local-blob",
        }
      : {
          BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
        }),
  }

  if (framework === "vite") {
    await execCommand("pnpm", ["--dir", "playground/vite", "build"], {
      cwd: workspaceRoot,
      env: {
        ...env,
        VITEHUB_HOSTING: provider,
        VITEHUB_VITE_MODE: "blob",
      },
    })
    return
  }

  await Promise.all([".output", ".vercel", ".nitro"].map(name => rm(resolve(dir(framework), name), { force: true, recursive: true })))
  await execCommand("node", ["--input-type=module", "-e", nitroBuildScript, dir(framework), provider === "cloudflare" ? "cloudflare-module" : "vercel"], {
    cwd: dir(framework),
    env: {
      ...env,
      NITRO_PRESET: provider === "cloudflare" ? "cloudflare-module" : "vercel",
      NODE_PATH: resolve(workspaceRoot, "node_modules"),
    },
  })
}

async function runCloudflare(framework: Framework) {
  log(`cloudflare × ${framework}`)
  await build(framework, "cloudflare")

  const port = await getFreePort()
  const inspectorPort = await getFreePort()
  const child = await startCommand("npx", [
    "wrangler",
    "--cwd",
    framework === "vite" ? "dist/vite" : ".output/server",
    "dev",
    "--config",
    "wrangler.json",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    "--show-interactive-dev-session=false",
  ], {
    cwd: dir(framework),
    env: { ...process.env, NO_COLOR: "1" },
  })
  const baseURL = `http://127.0.0.1:${port}`

  try {
    await waitForHttp(baseURL)
    await assertBlobRoundtrip(baseURL)
    log(`cloudflare × ${framework} ✓`)
  }
  catch (error) {
    await dumpChild(child, `cloudflare × ${framework} on port ${port}`, error)
  }
  finally {
    child.kill("SIGTERM")
    await child.exit
  }
}

async function runVercel(framework: Framework) {
  assert.ok(process.env.BLOB_READ_WRITE_TOKEN, "BLOB_READ_WRITE_TOKEN is required for Vercel blob e2e.")
  log(`vercel × ${framework}`)
  await build(framework, "vercel")

  const entry = [
    resolve(dir(framework), ".vercel/output/functions/__fallback.func/index.mjs"),
    resolve(dir(framework), ".vercel/output/functions/__server.func/index.mjs"),
  ].find(existsSync)
  if (!entry) {
    throw new Error(`Missing Vercel server entry for ${framework}.`)
  }

  const port = await getFreePort()
  const child = await startCommand("pnpm", ["exec", "tsx", vercelServer, entry], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
      PORT: String(port),
    },
  })
  const baseURL = `http://127.0.0.1:${port}`

  try {
    await waitForHttp(baseURL)
    await assertBlobRoundtrip(baseURL)
    log(`vercel × ${framework} ✓`)
  }
  catch (error) {
    await dumpChild(child, `vercel × ${framework} on port ${port}`, error)
  }
  finally {
    child.kill("SIGTERM")
    await child.exit
  }
}

async function runLive(url: string) {
  await assertBlobRoundtrip(url)
}

const providerRunner = {
  cloudflare: runCloudflare,
  vercel: runVercel,
} satisfies Record<Provider, (framework: Framework) => Promise<void>>

const { values } = parseArgs({
  options: {
    framework: { type: "string" },
    mode: { type: "string" },
    provider: { type: "string" },
    url: { type: "string" },
  },
  strict: true,
})

const mode = values.mode ?? "local"
const provider = values.provider as Provider | undefined
const framework = values.framework as Framework | undefined
if (provider) {
  assert.ok(PROVIDERS.includes(provider), `invalid --provider: ${provider}`)
}
if (framework) {
  assert.ok(FRAMEWORKS.includes(framework), `invalid --framework: ${framework}`)
}

if (mode === "live") {
  assert.ok(values.url, "--url required for live mode")
  await runLive(String(values.url))
}
else {
  const providers = provider ? [provider] : PROVIDERS
  const frameworks = framework ? [framework] : FRAMEWORKS
  await Promise.all(frameworks.map(async (currentFramework) => {
    for (const currentProvider of providers) {
      await providerRunner[currentProvider](currentFramework)
    }
  }))
}
