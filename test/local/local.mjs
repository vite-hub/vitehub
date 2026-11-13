#!/usr/bin/env node
// Local Provider Run orchestrator: executes built Provider Output on a local
// runtime and runs every Primitive Suite against it. Exceptions to local
// coverage are logged loudly, never skipped silently.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { manageChild } from "./process.mjs"
import { waitForProbe } from "./probe.mjs"

import { buildPlayground } from "./build-playground.mjs"

const repoRoot = resolve(import.meta.dirname, "..", "..")
const log = message => console.log(`[e2e:local] ${message}`)

const CLOUDFLARE_PORT = 8788
const VERCEL_PORT = 8789


async function runSuite(name, command, args, env = {}, register) {
  log(`suite ${name}: ${command} ${args.join(" ")}`)
  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: { ...process.env, ...env },
    stdio: "inherit",
  })
  register?.addChild(child)
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`[e2e:local] Primitive Suite "${name}" failed (exit ${code ?? signal}).`))
      })
    })
  }
  finally {
    register?.removeChild(child)
  }
}

function suiteRunner(provider, url, register) {
  const runTask = (name, task, args, env) => runSuite(name, "vp", ["run", task, ...args], env, register)
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
  // The repository Wrangler, so the local run uses the version that CI deploys with.
  const wrangler = resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js")
  const dev = spawn(process.execPath, [wrangler, "dev", "--config", "wrangler.json", "--port", String(CLOUDFLARE_PORT), "--test-scheduled", "--enable-containers=false"], {
    cwd: distDir,
    detached: process.platform !== "win32",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "inherit", "inherit"],
  })
  const stop = manageChild(dev)
  try {
    await waitForProbe(url)
    const run = suiteRunner("cloudflare", url, stop)
    await run.pkg("kv")
    await run.pkg("rate-limit")
    await run.script("queue")
    await run.script("schedule", ["--timeout", "90000"])
    await run.script("workflow")
    await run.pkg("workspace")
    await run.blob()
    await run.database()
    log("EXCEPTION (runtime): sandbox is live-only - it needs real containers.")
  }
  finally {
    await stop()
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
    detached: process.platform !== "win32",
    env: { ...process.env, ...bridgeEnv },
    stdio: ["ignore", "inherit", "inherit"],
  })
  const stop = manageChild(bridge)
  try {
    await waitForProbe(url)
    const run = suiteRunner("vercel", url, stop)
    if (hasUpstash) {
      await run.pkg("kv")
      await run.script("schedule", ["--timeout", "90000"])
    }
    else {
      log("EXCEPTION (env): kv and schedule on vercel-local need an Upstash-compatible endpoint (KV_REST_API_URL/TOKEN, e.g. serverless-redis-http). Suites NOT run - CI provides SRH services.")
    }
    await run.script("workflow")
    if (hasRemoteDatabase) {
      await run.database()
    }
    else {
      log("EXCEPTION (env): database on vercel-local needs a remote-shaped libSQL URL (TURSO_DATABASE_URL, e.g. a local sqld container). Suite NOT run - CI provides an sqld service.")
    }
    log("EXCEPTION (runtime): blob, queue, and workspace are live-only on vercel - @vercel/blob and Vercel Queue have no offline endpoint. Covered locally via cloudflare.")
    log("EXCEPTION (provider): rate-limit has no native Vercel driver. Covered locally and live via cloudflare.")
    log("EXCEPTION (runtime): sandbox is live-only - it needs real containers.")
  }
  finally {
    await stop()
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
