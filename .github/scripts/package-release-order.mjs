#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const root = process.argv[2] || process.cwd()
const packagesRoot = join(root, "packages")
const packages = readdirSync(packagesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap((entry) => {
    const path = join(packagesRoot, entry.name, "package.json")
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"))
      return manifest.private === true ? [] : [{ manifest, path }]
    }
    catch (error) {
      if (error.code === "ENOENT") return []
      throw error
    }
  })

const byName = new Map(packages.map(pkg => [pkg.manifest.name, pkg]))
const ordered = []
const visited = new Set()
const visiting = new Set()

function visit(pkg) {
  const name = pkg.manifest.name
  if (visited.has(name)) return
  if (visiting.has(name)) throw new Error(`Circular public package dependency at ${name}`)
  visiting.add(name)

  const dependencies = {
    ...pkg.manifest.dependencies,
    ...pkg.manifest.optionalDependencies,
    ...pkg.manifest.peerDependencies,
  }
  for (const dependency of Object.keys(dependencies).sort()) {
    const owner = byName.get(dependency)
    if (owner) visit(owner)
  }

  visiting.delete(name)
  visited.add(name)
  ordered.push(pkg)
}

for (const pkg of packages.toSorted((left, right) => left.manifest.name.localeCompare(right.manifest.name))) {
  visit(pkg)
}

process.stdout.write(`${ordered.map(pkg => relative(root, pkg.path)).join("\n")}\n`)
