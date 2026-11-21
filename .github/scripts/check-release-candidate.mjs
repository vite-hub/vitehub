#!/usr/bin/env node

import { globSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const branch = process.argv[2]
const match = /^release\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(branch || "")
if (!match) throw new Error(`Invalid release branch: ${branch || "(missing)"}`)
if (match[4]?.split(".").some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
  throw new Error(`Invalid release branch: ${branch}`)
}

const version = branch.slice("release/v".length)
const root = JSON.parse(readFileSync("package.json", "utf8"))
if (root.version !== version) throw new Error(`Root version ${root.version} does not match ${version}`)

const packages = []
for (const entry of readdirSync("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const path = join("packages", entry.name, "package.json")
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"))
  }
  catch (error) {
    if (error.code === "ENOENT") continue
    throw error
  }
  if (manifest.private === true) continue
  if (manifest.version !== version) {
    throw new Error(`${manifest.name} version ${manifest.version} does not match ${version}`)
  }
  packages.push({ path, manifest })
}
if (packages.length === 0) throw new Error("No publishable packages found")

const releaseNames = new Set(packages.map(({ manifest }) => manifest.name))
const workspaceGlobs = /^packages:\n((?:[ \t]+-.*\n)+)/m.exec(readFileSync("pnpm-workspace.yaml", "utf8"))?.[1]
  .split("\n")
  .map(line => line.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, ""))
  .filter(Boolean)
if (!workspaceGlobs?.length) throw new Error("pnpm-workspace.yaml lists no packages")
for (const path of ["package.json", ...workspaceGlobs.flatMap(pattern => globSync(`${pattern}/package.json`))]) {
  const manifest = JSON.parse(readFileSync(path, "utf8"))
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest[section] || {})) {
      if (releaseNames.has(name) && !range.startsWith("workspace:") && range !== "*") {
        throw new Error(`${path} ${section} ${name} is ${range}. Use a workspace: range, or * when that range makes a build cycle, so a release needs no second commit.`)
      }
    }
  }
}

console.log(`Validated ${packages.length} packages at ${version}`)
