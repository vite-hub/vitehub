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
  const runTask = (name, task, args, env) => runSuite(name, "vp", ["run", task, ...args], env)
  return {
    // blob and database take no --provider flag (parseArgs strict), matching the live workflow.
    blob: () => runTask("blob", "blob:e2e", ["--mode", "local", "--url", url]),
    database: () => runTask("database", "database:e2e", ["--url", url]),
    pkg: (name, extra = []) => runTask(name, `${name}:e2e`, ["--mode", "local", "--provider", provider, "--url", url, ...extra]),
    script: (name, extra = []) => runTask(name, `${name}:e2e`, ["--mode", "local", "--provider", provider, "--url", url, ...extra]),
  }
}

async function runCloudflare() {
  const distDir = resolve(repoRoot, "playground/vite/dist/vite")
  if (!existsSync(resolve(distDir, "wrangler.json"))) {
    throw new Error("[e2e:local] Missing Cloudflare Provider Output. Run with --build or build the playground first.")
  }
  const url = `http://127.0.0.1:${CLOUDFLARE_PORT}`
  log(`starting wrangler dev on ${url}`)
  const dev = spawn("vp", ["dlx", "wrangler", "dev", "--config", "wrangler.json", "--port", String(CLOUDFLARE_PORT), "--test-scheduled", "--enable-containers=false"], {
    cwd: distDir,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "inherit", "inherit"],
  })
  try {
    await waitForProbe(url)
    const run = suiteRunner("cloudflare", url)
    run.pkg("kv")
    run.pkg("rate-limit")
    run.script("queue")
    run.script("schedule", ["--timeout", "90000"])
    run.script("workflow")
    run.pkg("workspace")
    run.blob()
    run.database()
    log("EXCEPTION (runtime): sandbox is live-only - it needs real containers.")
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
  // The hosted DB runtime rejects file: URLs by design; a remote-shaped URL
  // (e.g. a local sqld container) is required for the database suite.
  const databaseUrl = process.env.TURSO_DATABASE_URL || `file:${resolve(repoRoot, ".vitehub/local-e2e.db")}`
  const hasRemoteDatabase = !databaseUrl.startsWith("file:")
  const bridgeEnv = {
    // Emulate the documented Vercel runtime env so provider detection works.
    VERCEL: "1",
    VERCEL_ENV: "development",
    // Placeholders satisfy import-time env checks for primitives whose suites
    // are excepted locally (blob) or env-gated (kv); real env always wins.
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN || "vercel_blob_rw_local_placeholder",
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN || "local-placeholder",
    KV_REST_API_URL: process.env.KV_REST_API_URL || "https://localhost.invalid",
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || "local-placeholder",
    TURSO_DATABASE_URL: databaseUrl,
  }
  const hasUpstash = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  const url = `http://127.0.0.1:${VERCEL_PORT}`
  log(`starting vercel function bridge on ${url}`)
  const bridge = spawn("node", [resolve(import.meta.dirname, "vercel-bridge-server.mjs"), "--output-dir", outputDir, "--port", String(VERCEL_PORT)], {
    env: { ...process.env, ...bridgeEnv },
    stdio: ["ignore", "inherit", "inherit"],
  })
  try {
    await waitForProbe(url)
    const run = suiteRunner("vercel", url)
    if (hasUpstash) {
      run.pkg("kv")
      run.script("schedule", ["--timeout", "90000"])
    }
    else {
      log("EXCEPTION (env): kv and schedule on vercel-local need an Upstash-compatible endpoint (KV_REST_API_URL/TOKEN, e.g. serverless-redis-http). Suites NOT run - CI provides SRH services.")
    }
    run.script("workflow")
    if (hasRemoteDatabase) {
      run.database()
    }
    else {
      log("EXCEPTION (env): database on vercel-local needs a remote-shaped libSQL URL (TURSO_DATABASE_URL, e.g. a local sqld container). Suite NOT run - CI provides an sqld service.")
    }
    log("EXCEPTION (runtime): blob, queue, and workspace are live-only on vercel - @vercel/blob and Vercel Queue have no offline endpoint. Covered locally via cloudflare.")
    log("EXCEPTION (provider): rate-limit has no native Vercel driver. Covered locally and live via cloudflare.")
    log("EXCEPTION (runtime): sandbox is live-only - it needs real containers.")
  }
  finally {
    bridge.kill("SIGTERM")
    await sleep(500)
    if (!bridge.killed) bridge.kill("SIGKILL")
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
