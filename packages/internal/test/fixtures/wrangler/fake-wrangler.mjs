#!/usr/bin/env node
// A fake `wrangler` for host credential tests. It records its arguments and prints a recorded fixture.
import { appendFileSync, readFileSync } from "node:fs"

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_WRANGLER_LOG, `${JSON.stringify(args)}\n`)
const mode = process.env.FAKE_WRANGLER_MODE
if (mode === "logged-out") {
  process.stderr.write("✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.\n")
  process.exit(1)
}
const command = args.slice(0, 2).join(" ")
const fixture = command === "auth token" ? (mode === "api-key" ? "auth-token-api-key.json" : "auth-token-oauth.json") : command === "whoami --json" ? "whoami.json" : undefined
if (!fixture) process.exit(1)
process.stdout.write(readFileSync(new URL(fixture, import.meta.url), "utf8"))
