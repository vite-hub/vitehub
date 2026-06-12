#!/usr/bin/env node
// Local Provider Run orchestrator: executes built Provider Output on a local
// runtime and runs every Primitive Suite against it. Exceptions to local
// coverage are logged loudly, never skipped silently.
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { buildPlayground } from "./build-playground.mjs"
import { createVercelBridge } from "./vercel-bridge.mjs"

const repoRoot = resolve(import.meta.dirname, "..", "..")
const log = message => console.log(`[e2e:local] ${message}`)

const CLOUDFLARE_PORT = 8788
const VERCEL_PORT = 8789

async function waitForProbe(url, timeoutMs = 60_000) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("/api/tests/probe", url))
      if (response.ok) return
      lastError = new Error(`probe status ${response.status}`)
    }
    catch (error) {
      lastError = error
    }
    await sleep(1_000)
  }
  throw new Error(`[e2e:local] App at ${url} never became healthy: ${lastError}`)
}

function runSuite(name, command, args, env = {}) {
  log(`suite ${name}: ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`[e2e:local] Primitive Suite "${name}" failed (exit ${result.status}).`)
  }
}

function suiteRunner(provider, url) {
  return {
    // blob and database take no --provider flag (parseArgs strict), matching the live workflow.
    blob: () => runSuite("blob", "pnpm", ["--dir", "packages/blob", "test:e2e", "--mode", "local", "--url", url]),
    database: () => runSuite("database", "pnpm", ["--dir", "packages/database", "test:e2e", "--url", url]),
    pkg: (name, extra = []) => runSuite(name, "pnpm", ["--dir", `packages/${name}`, "test:e2e", "--mode", "local", "--provider", provider, "--url", url, ...extra]),
    script: (name, extra = []) => runSuite(name, "node", [`packages/${name}/test/e2e-live.mjs`, "--mode", "local", "--provider", provider, "--url", url, ...extra]),
  }
}

async function runCloudflare() {
  const distDir = resolve(repoRoot, "playground/vite/dist/vite")
  if (!existsSync(resolve(distDir, "wrangler.json"))) {
    throw new Error("[e2e:local] Missing Cloudflare Provider Output. Run with --build or build the playground first.")
  }
  const url = `http://127.0.0.1:${CLOUDFLARE_PORT}`
  log(`starting wrangler dev on ${url}`)
  const dev = spawn("npx", ["wrangler", "dev", "--config", "wrangler.json", "--port", String(CLOUDFLARE_PORT), "--test-scheduled"], {
    cwd: distDir,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "inherit", "inherit"],
  })
  try {
    await waitForProbe(url)
    const run = suiteRunner("cloudflare", url)
    run.pkg("kv")
    run.script("queue")
    run.script("schedule", ["--timeout", "90000"])
    run.script("workflow")
    run.pkg("workspace")
    run.blob()
    run.database()
    log("EXCEPTION (documented): sandbox is live-only - it needs real containers. See .agents/contexts/verification/CONTEXT.md")
  }
  finally {
    dev.kill("SIGTERM")
    await sleep(500)
    if (!dev.killed) dev.kill("SIGKILL")
  }
}

async function runVercel() {
  const outputDir = resolve(repoRoot, "playground/vite/.vercel/output")
  if (!existsSync(resolve(outputDir, "config.json"))) {
    throw new Error("[e2e:local] Missing Vercel Provider Output. Run with --build or build the playground first.")
  }
  const databaseUrl = process.env.TURSO_DATABASE_URL || `file:${resolve(repoRoot, ".vitehub/local-e2e.db")}`
  const bridgeEnv = {
    TURSO_DATABASE_URL: databaseUrl,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || "local-placeholder",
  }
  const hasUpstash = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  const url = `http://127.0.0.1:${VERCEL_PORT}`
  log(`starting vercel function bridge on ${url}`)
  const bridge = await createVercelBridge({ outputDir, port: VERCEL_PORT, env: bridgeEnv })
  try {
    await waitForProbe(url)
    const run = suiteRunner("vercel", url)
    if (hasUpstash) {
      run.pkg("kv")
    }
    else {
      log("EXCEPTION (env): kv on vercel-local needs an Upstash-compatible endpoint (KV_REST_API_URL/TOKEN, e.g. serverless-redis-http). Suite NOT run.")
    }
    run.script("queue")
    run.script("schedule", ["--timeout", "90000"])
    run.script("workflow")
    run.database()
    log("EXCEPTION (documented): blob and workspace are live-only on vercel - @vercel/blob has no offline endpoint. Covered locally via cloudflare. See .agents/contexts/verification/CONTEXT.md")
    log("EXCEPTION (documented): sandbox is live-only - it needs real containers.")
  }
  finally {
    await bridge.close()
  }
}

const { values } = parseArgs({
  options: { provider: { type: "string" }, build: { type: "boolean" } },
  strict: true,
})
const provider = values.provider
if (provider !== "cloudflare" && provider !== "vercel") {
  throw new Error("--provider cloudflare|vercel required")
}
if (values.build) buildPlayground(provider)
await (provider === "cloudflare" ? runCloudflare() : runVercel())
log(`${provider} local run ✓`)
