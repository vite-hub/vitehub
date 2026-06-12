#!/usr/bin/env node
// Builds playground/vite for one provider with offline-safe placeholder env.
// Real env vars always win - placeholders only fill gaps so PR CI needs no cloud account.
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..", "..")

const PLACEHOLDERS = {
  cloudflare: {
    BLOB_BUCKET_NAME: "vitehub-local-blob",
    KV_NAMESPACE_ID: "00000000000000000000000000000000",
    TURSO_AUTH_TOKEN: "local-placeholder",
    TURSO_DATABASE_URL: "file:.vitehub/local-e2e.db",
    VITEHUB_CLOUDFLARE_WORKER_NAME: "vitehub-playground-vite",
    VITEHUB_D1_ANALYTICS_DATABASE_ID: "00000000-0000-0000-0000-000000000002",
    VITEHUB_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000001",
  },
  vercel: {
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_local_placeholder",
    KV_REST_API_TOKEN: "local-placeholder",
    KV_REST_API_URL: "https://localhost.invalid",
    TURSO_AUTH_TOKEN: "local-placeholder",
    TURSO_DATABASE_URL: "file:.vitehub/local-e2e.db",
    VITEHUB_WORKSPACE_BLOB_PREFIX: "vitehub/workspace-local/vite",
  },
}

export function buildPlayground(provider, { mode = "e2e" } = {}) {
  if (!(provider in PLACEHOLDERS)) {
    throw new Error(`[vitehub] Unknown provider "${provider}". Expected cloudflare | vercel.`)
  }
  const env = { ...PLACEHOLDERS[provider], ...process.env, VITEHUB_HOSTING: provider, VITEHUB_VITE_MODE: mode }
  const result = spawnSync("vp", ["build"], { cwd: resolve(repoRoot, "playground/vite"), env, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`[vitehub] playground build failed for provider "${provider}" (exit ${result.status}).`)
  }
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { provider: { type: "string" }, mode: { type: "string" } }, strict: true })
  if (!values.provider) throw new Error("--provider cloudflare|vercel required")
  buildPlayground(values.provider, { mode: values.mode ?? "e2e" })
}
