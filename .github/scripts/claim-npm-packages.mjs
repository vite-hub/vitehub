#!/usr/bin/env node

// The release workflow publishes with npm trusted publishing only, and npm can link a trusted publisher only to a
// package that already exists. Run this script once, signed in to npm (`npm login`), before the first release of a new
// package. For each publishable package under packages/ that npm does not have yet, it:
//
// 1. publishes a placeholder `0.0.0-claim` under the `claim` dist-tag, so the name exists, and
// 2. links the package to `.github/workflows/release.yml` in the `npm-release` environment of vite-hub/vitehub.
//
// npm asks for two-factor authentication on the first publish and the first `npm trust` call. Choose "skip for the next
// 5 minutes" on the npm page so the rest of the run does not ask again.
//
// Run: node .github/scripts/claim-npm-packages.mjs [--dry-run] [<package name>...]
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const registry = "https://registry.npmjs.org"
const placeholderVersion = "0.0.0-claim"
const placeholderTag = "claim"
const trust = { file: "release.yml", repository: "vite-hub/vitehub", environment: "npm-release" }

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const only = args.filter(arg => !arg.startsWith("--"))
const repoRoot = resolve(import.meta.dirname, "../..")

function npm(npmArgs, options = {}) {
  console.log(`$ npm ${npmArgs.join(" ")}`)
  const result = spawnSync("npm", npmArgs, { stdio: "inherit", ...options })
  if (result.status !== 0) throw new Error(`npm ${npmArgs[0]} failed with exit code ${result.status}`)
}

/** The name, description and repository of every package under packages/ that is not private. */
function publishablePackages() {
  const packages = []
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(repoRoot, "packages", entry.name, "package.json"), "utf8"))
    }
    catch {
      continue
    }
    if (manifest.private === true || typeof manifest.name !== "string") continue
    packages.push({ name: manifest.name, description: manifest.description, repository: manifest.repository, license: manifest.license })
  }
  return packages
}

async function existsOnNpm(name) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, { headers: { accept: "application/vnd.npm.install-v1+json" } })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`The registry answered ${response.status} for ${name}.`)
  return true
}

function publishPlaceholder(pkg) {
  const directory = mkdtempSync(join(tmpdir(), "vitehub-claim-"))
  try {
    writeFileSync(join(directory, "package.json"), `${JSON.stringify({
      name: pkg.name,
      version: placeholderVersion,
      description: `Placeholder that reserves ${pkg.name}. The first release replaces it. ${pkg.description ?? ""}`.trim(),
      license: pkg.license,
      repository: pkg.repository,
      homepage: "https://vitehub.dev",
    }, null, 2)}\n`)
    writeFileSync(join(directory, "README.md"), `# ${pkg.name}\n\nThis version only reserves the name. Install the latest version from the ViteHub release.\n`)
    npm(["publish", "--access", "public", "--tag", placeholderTag, "--ignore-scripts", ...(dryRun ? ["--dry-run"] : [])], { cwd: directory })
  }
  finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

function linkTrustedPublisher(name) {
  npm([
    "trust", "github", name,
    "--file", trust.file,
    "--repository", trust.repository,
    "--environment", trust.environment,
    "--allow-publish",
    "--yes",
    ...(dryRun ? ["--dry-run"] : []),
  ])
}

const packages = publishablePackages().filter(pkg => only.length === 0 || only.includes(pkg.name))
const unknown = only.filter(name => !packages.some(pkg => pkg.name === name))
if (unknown.length) throw new Error(`Not a publishable package under packages/: ${unknown.join(", ")}`)

const missing = []
for (const pkg of packages) {
  if (!await existsOnNpm(pkg.name)) missing.push(pkg)
}
if (missing.length === 0) {
  console.log("npm has every publishable package. Nothing to claim.")
  process.exit(0)
}
console.log(`npm does not have: ${missing.map(pkg => pkg.name).join(", ")}${dryRun ? " (dry run)" : ""}`)

if (!dryRun) npm(["whoami"])

for (const pkg of missing) publishPlaceholder(pkg)

if (!dryRun) {
  // npm needs a moment before a new package accepts a trusted publisher.
  for (const pkg of missing) {
    for (let attempt = 0; !await existsOnNpm(pkg.name); attempt++) {
      if (attempt === 10) throw new Error(`${pkg.name} is still missing from the registry after its publish.`)
      await sleep(3000)
    }
  }
}

for (const [index, pkg] of missing.entries()) {
  // npm asks for at most one `npm trust` call every 2 seconds.
  if (index > 0) await sleep(2000)
  linkTrustedPublisher(pkg.name)
}

console.log(`\nClaimed ${missing.length} package(s). Check them with: npm trust list <package>`)
