#!/usr/bin/env node

// The release workflow publishes with npm trusted publishing only, and npm can link a trusted publisher only to a
// package that already exists. Run this script once, signed in to npm (`npm login`), before the first release of a new
// package. For each publishable package under packages/ that npm does not have yet, it:
//
// 1. publishes a placeholder `0.0.0-claim` under the `claim` dist-tag, so the name exists, and
// 2. links every publishable package without a trusted publisher to `.github/workflows/release.yml` in the
//    `npm-release` environment of vite-hub/vitehub. A second run picks up what the first left.
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

function npmOutput(npmArgs) {
  const result = spawnSync("npm", npmArgs, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] })
  if (result.status !== 0) throw new Error(`npm ${npmArgs.join(" ")} failed with exit code ${result.status}`)
  return result.stdout
}

/** The packages of the scopes of `packages` that the signed-in account can write. */
function ownedPackages(packages) {
  const names = new Set()
  for (const scope of new Set(packages.map(pkg => pkg.name.split("/")[0]).filter(part => part.startsWith("@")))) {
    for (const name of Object.keys(JSON.parse(npmOutput(["access", "list", "packages", scope, "--json"]) || "{}"))) names.add(name)
  }
  return names
}

function hasTrustedPublisher(name) {
  return npmOutput(["trust", "list", name, "--json"]).trim() !== ""
}

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

// The registry answers 404 for a new package for some minutes after its publish, so ask npm which packages the signed-in
// account has. A dry run without a login only asks the registry.
const owned = dryRun ? new Set() : ownedPackages(packages)
const missing = []
for (const pkg of packages) {
  if (!owned.has(pkg.name) && !await existsOnNpm(pkg.name)) missing.push(pkg)
}
if (missing.length) console.log(`npm does not have: ${missing.map(pkg => pkg.name).join(", ")}${dryRun ? " (dry run)" : ""}`)
for (const pkg of missing) publishPlaceholder(pkg)

const untrusted = dryRun ? missing : packages.filter(pkg => !hasTrustedPublisher(pkg.name))
if (untrusted.length) console.log(`No trusted publisher: ${untrusted.map(pkg => pkg.name).join(", ")}`)
for (const [index, pkg] of untrusted.entries()) {
  // npm asks for at most one `npm trust` call every 2 seconds.
  if (index > 0) await sleep(2000)
  linkTrustedPublisher(pkg.name)
}

if (dryRun) console.log("\nDry run: reading trusted publishers needs a login, so only a real run checks the packages that npm has.")
else {
  console.log(missing.length || untrusted.length
    ? `\nClaimed ${missing.length} and linked ${untrusted.length} package(s).`
    : "Every publishable package is on npm with a trusted publisher.")
}
