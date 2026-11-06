#!/usr/bin/env node
// A fake `wrangler` for host credential tests. It records its arguments and prints a recorded fixture.
import { appendFileSync, existsSync, readFileSync } from "node:fs"

// Wrangler loads these files from its working directory before handling auth commands.
let loadedDotenv = false
for (const file of [".env", ".env.local"]) {
  if (existsSync(file)) {
    process.loadEnvFile(file)
    loadedDotenv = true
  }
}

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_WRANGLER_LOG, `${JSON.stringify(args)}\n`)
const mode = process.env.FAKE_WRANGLER_MODE
if (mode === "logged-out") {
  process.stderr.write("✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.\n")
  process.exit(1)
}
const command = args.slice(0, 2).join(" ")
if (loadedDotenv && process.env.CLOUDFLARE_API_TOKEN) {
  process.stdout.write(JSON.stringify(command === "auth token"
    ? { type: "api_token", token: process.env.CLOUDFLARE_API_TOKEN }
    : { loggedIn: true, accounts: [{ id: "dotenv-account" }] }))
  process.exit(0)
}
const fixture = command === "auth token" ? (mode === "api-key" ? "auth-token-api-key.json" : "auth-token-oauth.json") : command === "whoami --json" ? "whoami.json" : undefined
if (!fixture) process.exit(1)
process.stdout.write(readFileSync(new URL(fixture, import.meta.url), "utf8"))
