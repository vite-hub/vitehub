#!/usr/bin/env node

// The release workflow publishes with npm trusted publishing only, and npm can link a trusted publisher only to a
// package that already exists. Run this script once, signed in to npm (`npm login`), before the first release of a new
// package. For each publishable package under packages/ that npm does not have yet, it:
//
// 1. publishes a placeholder `0.0.0-claim` under the `claim` dist-tag, so the name exists, and
// 2. links every publishable package that the release job cannot publish to `.github/workflows/release.yml` in the
//    `npm-release` environment of vite-hub/vitehub, replacing only links for that repository and workflow. A second
//    run picks up what the first left.
//
// npm asks for two-factor authentication on a publish and on trusted publisher changes. The script prints the sign-in
// link and waits. Choose "skip for the next 5 minutes" on the npm page so the rest of the run does not ask again.
//
// npm lets a trusted publisher configuration expire, and the CLI does not show it: the website says "Expired" and the
// release job fails with ENEEDAUTH. `--replace` also refreshes otherwise matching release links when the package version
// in packages/ is not on npm yet.
//
// Run: node .github/scripts/claim-npm-packages.mjs [--dry-run] [--replace] [<package name>...]
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
const replace = args.includes("--replace")
const only = args.filter(arg => !arg.startsWith("--"))
const repoRoot = resolve(import.meta.dirname, "../..")

function npmOutput(npmArgs) {
  const result = spawnSync("npm", npmArgs, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`npm ${npmArgs.join(" ")} failed with exit code ${result.status}`)
  }
  return result.stdout
}

/** The token of `npm login`, from NPM_TOKEN or the user .npmrc. */
function npmToken() {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN
  const userConfig = npmOutput(["config", "get", "userconfig"]).trim()
  const token = readFileSync(userConfig, "utf8").match(/^\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(.+)$/m)?.[1]?.trim()
  if (!token) throw new Error(`No npm token for ${registry} in ${userConfig}. Run \`npm login\` first.`)
  return token
}

let token
let otp

/**
 * Calls the trusted publisher API of the registry, as `npm trust` does. `npm trust` waits for the browser sign-in only
 * when it writes to a terminal, and with `--json` it holds the sign-in link back until it ends, so the script cannot
 * read its output. When the registry asks for two-factor authentication, this prints the link, waits for the sign-in,
 * and keeps the one-time password for the next calls.
 */
async function trustApi(method, name, path = "", body) {
  token ??= npmToken()
  const url = `${registry}/-/package/${name.replace("/", "%2f")}/trust${path}`
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: {
        "authorization": `Bearer ${token}`,
        "npm-auth-type": "web",
        "npm-command": "trust",
        ...otp && { "npm-otp": otp },
        ...body && { "content-type": "application/json" },
      },
      ...body && { body: JSON.stringify(body) },
    })
    const text = await response.text()
    if (response.ok) return text ? JSON.parse(text) : undefined
    const challenge = response.status === 401 && /otp/i.test(response.headers.get("www-authenticate") ?? "") ? JSON.parse(text || "{}") : undefined
    if (!challenge || attempt > 2) throw new Error(`${method} ${url} answered ${response.status}: ${text}`)
    // A kept password that npm no longer accepts: try once without it, since "skip for the next 5 minutes" may cover it.
    if (otp) {
      otp = undefined
      continue
    }
    if (!challenge.authUrl || !challenge.doneUrl) throw new Error(`npm asks for a one-time password for ${name} without a sign-in link: ${text}`)
    console.log(`\nnpm asks for two-factor authentication. Open this link, sign in and choose "skip for the next 5 minutes":\n${challenge.authUrl}\n`)
    otp = await signInPassword(challenge.doneUrl)
    console.log("Signed in.")
  }
}

async function signInPassword(doneUrl) {
  for (;;) {
    const response = await fetch(doneUrl, { headers: { authorization: `Bearer ${token}` } })
    if (response.status === 200) return (await response.json()).token
    if (response.status !== 202) throw new Error(`The npm sign-in answered ${response.status}: ${await response.text()}`)
    await sleep(Math.max(1000, Number(response.headers.get("retry-after")) * 1000 || 0))
  }
}

/** The packages of the scopes of `packages` that the signed-in account can write. */
function ownedPackages(packages) {
  const names = new Set()
  for (const scope of new Set(packages.map(pkg => pkg.name.split("/")[0]).filter(part => part.startsWith("@")))) {
    for (const name of Object.keys(JSON.parse(npmOutput(["access", "list", "packages", scope, "--json"]) || "{}"))) names.add(name)
  }
  return names
}

/** The GitHub trusted publisher configurations for this repository's release workflow. */
async function releaseTrustConfigs(name) {
  const body = await trustApi("GET", name)
  return (Array.isArray(body) ? body : body ? [body] : []).filter(config =>
    config.type === "github" && config.claims?.repository === trust.repository && config.claims?.workflow_ref?.file === trust.file,
  ).map(config => ({
    id: config.id,
    environment: config.claims?.environment,
    permissions: config.permissions,
  }))
}

/**
 * The release job runs `npm publish` in the `npm-release` environment. A configuration without an environment also
 * accepts it. `createPackage` is the publish permission; a configuration with only `createStagedPackage` cannot publish.
 */
function publishesFromRelease(config) {
  return (config.environment == null || config.environment === trust.environment)
    && (config.permissions ?? []).includes("createPackage")
}

function describeConfig(config) {
  return `${trust.file} in ${config.environment ?? "any environment"} (${(config.permissions ?? []).join(", ") || "no permissions"})`
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
    packages.push({ name: manifest.name, version: manifest.version, description: manifest.description, repository: manifest.repository, license: manifest.license })
  }
  return packages
}

async function existsOnNpm(name) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, { headers: { accept: "application/vnd.npm.install-v1+json" } })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`The registry answered ${response.status} for ${name}.`)
  return true
}

async function versionOnNpm(name, version) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`)
  return response.ok
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
    npm(["publish", "--access", "public", "--tag", placeholderTag, "--ignore-scripts", "--browser=false", ...(dryRun ? ["--dry-run"] : [])], { cwd: directory })
  }
  finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

async function linkTrustedPublisher(name) {
  console.log(`${name}: link ${trust.file} in ${trust.environment} of ${trust.repository}${dryRun ? " (dry run)" : ""}`)
  if (dryRun) return
  await trustApi("POST", name, "", [{
    type: "github",
    claims: { repository: trust.repository, workflow_ref: { file: trust.file }, environment: trust.environment },
    permissions: ["createPackage", "createStagedPackage"],
  }])
}

async function revokeTrustedPublisher(name, config) {
  console.log(`${name}: revoke ${describeConfig(config)}`)
  await trustApi("DELETE", name, `/${encodeURIComponent(config.id)}`)
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

// Replace only this repository's release workflow links; other publishers can coexist with the release link.
const untrusted = []
if (dryRun) untrusted.push(...missing.map(pkg => ({ pkg, stale: [] })))
else {
  for (const pkg of packages) {
    const configs = await releaseTrustConfigs(pkg.name)
    // npm lets a configuration expire, and `npm trust list` does not say so. With --replace, every package that has not
    // published its version yet gets a fresh configuration.
    if (!configs.some(publishesFromRelease) || (replace && !await versionOnNpm(pkg.name, pkg.version))) {
      untrusted.push({ pkg, stale: configs })
    }
    await sleep(500)
  }
}
for (const { pkg, stale } of untrusted) {
  console.log(`${pkg.name}: ${stale.length ? `has ${stale.map(describeConfig).join(", ")}` : "no link for the release workflow"}`)
}
for (const [index, { pkg, stale }] of untrusted.entries()) {
  // npm asks for at most one trusted publisher change every 2 seconds.
  if (index > 0) await sleep(2000)
  for (const config of stale) {
    await revokeTrustedPublisher(pkg.name, config)
    await sleep(2000)
  }
  await linkTrustedPublisher(pkg.name)
}

if (dryRun) console.log("\nDry run: reading trusted publishers needs a login, so only a real run checks the packages that npm has.")
else {
  console.log(missing.length || untrusted.length
    ? `\nClaimed ${missing.length} and linked ${untrusted.length} package(s).`
    : "Every publishable package is on npm with a trusted publisher for the release job.")
}
