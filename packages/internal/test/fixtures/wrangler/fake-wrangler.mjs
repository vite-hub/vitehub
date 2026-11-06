#!/usr/bin/env node
// A fake `wrangler` for host credential tests. It records its arguments and prints a recorded fixture.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_WRANGLER_LOG, `${JSON.stringify(args)}\n`)
const mode = process.env.FAKE_WRANGLER_MODE
if (mode === "logged-out") {
  process.stderr.write("✘ [ERROR] Not logged in. Please run `wrangler login` to authenticate.\n")
  process.exit(1)
}
const command = args.slice(0, 2).join(" ")
// Model Wrangler's project discovery so the tests can detect accidental project credentials.
if (mode === "project-state") {
  const envFiles = args.includes("--env-file") ? [args[args.indexOf("--env-file") + 1]] : [".env", ".env.local"]
  let projectToken
  for (const file of envFiles) {
    if (existsSync(file)) projectToken = readFileSync(file, "utf8").match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1] ?? projectToken
  }
  const configFile = args.includes("--config") ? args[args.indexOf("--config") + 1] : "wrangler.json"
  if (existsSync(configFile)) JSON.parse(readFileSync(configFile, "utf8"))
  // Wrangler resolves activated profiles from the config directory, including its ancestors.
  const profileDirectory = process.env.FAKE_WRANGLER_PROFILE_DIRECTORY
  const configDirectory = dirname(resolve(configFile))
  const hasBoundProfile = profileDirectory && (configDirectory === profileDirectory || configDirectory.startsWith(`${profileDirectory}${sep}`))
  const token = process.env.CLOUDFLARE_API_TOKEN ?? projectToken ?? (hasBoundProfile ? "bound-profile-token" : "fake-oauth-token-from-wrangler")
  const accountId = token === "project-token" ? "project-account" : hasBoundProfile ? "bound-profile-account" : "fake-account-id"
  process.stdout.write(JSON.stringify(command === "auth token" ? { type: "oauth", token } : { loggedIn: true, accounts: [{ id: accountId }] }))
  process.exit(0)
}
const fixture = command === "auth token" ? (mode === "api-key" ? "auth-token-api-key.json" : "auth-token-oauth.json") : command === "whoami --json" ? "whoami.json" : undefined
if (!fixture) process.exit(1)
process.stdout.write(readFileSync(new URL(fixture, import.meta.url), "utf8"))
