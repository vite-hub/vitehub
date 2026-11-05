#!/usr/bin/env node

import { globSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const branch = process.argv[2]
const match = /^release\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(branch || "")
if (!match) throw new Error(`Invalid release branch: ${branch || "(missing)"}`)
if (match[4]?.split(".").some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
  throw new Error(`Invalid release branch: ${branch}`)
}

const version = branch.slice("release/v".length)
const bump = process.argv[3] === "--bump"
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

if (bump) {
  const names = new Set(packages.map(({ manifest }) => manifest.name))
  const updateRanges = (dependencies = {}) => {
    for (const [name, range] of Object.entries(dependencies)) {
      if (!names.has(name) || range.startsWith("workspace:") || range === "*") continue
      const match = /^([~^]?)(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(range)
      if (!match) throw new Error(`Unsupported release range for ${name}: ${range}`)
      dependencies[name] = `${match[1]}${version}`
    }
  }
  const writeManifest = (path, manifest) => {
    const source = `${JSON.stringify(manifest, null, 2)}\n`
    if (readFileSync(path, "utf8") !== source) writeFileSync(path, source)
  }

  for (const { path, manifest } of packages) {
    updateRanges(manifest.peerDependencies)
    writeManifest(path, manifest)
  }
  for (const path of globSync("packages/codemods/test/fixtures/**/output/package.json")) {
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      updateRanges(manifest[field])
    }
    writeManifest(path, manifest)
  }
}

console.log(`Validated ${packages.length} packages at ${version}`)
