// Vite reads node_modules/.modules.yaml while it resolves a config, so the Vite+
// task cache fingerprints it. pnpm writes the install time into prunedAt, and
// when a package is installed in several versions it does not always hoist the
// same one, so two fresh installs of one lockfile write different files and a
// restored task cache never replays a build. Vite only needs virtualStoreDir.
// pnpm only reads hoistedDependencies to unlink old hoisted packages on the next
// install, which a CI job never runs.
import { readFileSync, writeFileSync } from "node:fs"

const file = process.argv[2] ?? "node_modules/.modules.yaml"

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).toSorted().map(key => [key, sortKeys(value[key])]))
}

const modules = JSON.parse(readFileSync(file, "utf8"))
modules.prunedAt = new Date(0).toUTCString()
modules.hoistedDependencies = {}
writeFileSync(file, `${JSON.stringify(sortKeys(modules), null, 2)}\n`)
