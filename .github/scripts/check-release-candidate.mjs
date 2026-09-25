#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs"
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

let count = 0
for (const entry of readdirSync("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join("packages", entry.name, "package.json"), "utf8"))
  }
  catch (error) {
    if (error.code === "ENOENT") continue
    throw error
  }
  if (manifest.private === true) continue
  if (manifest.version !== version) {
    throw new Error(`${manifest.name} version ${manifest.version} does not match ${version}`)
  }
  count++
}
if (count === 0) throw new Error("No publishable packages found")
console.log(`Validated ${count} packages at ${version}`)
