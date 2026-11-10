// pnpm writes node_modules/.modules.yaml with the install time in prunedAt and
// the hoisted packages in a different order on every install. Vite reads this
// file while it resolves a config, so the Vite+ task cache fingerprints it, and
// a task cache restored on CI never replayed a build. Sorted keys and a fixed
// prunedAt make two installs of the same lockfile write the same file.
import { readFileSync, writeFileSync } from "node:fs"

const file = process.argv[2] ?? "node_modules/.modules.yaml"

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).toSorted().map(key => [key, sortKeys(value[key])]))
}

const modules = JSON.parse(readFileSync(file, "utf8"))
modules.prunedAt = new Date(0).toUTCString()
writeFileSync(file, `${JSON.stringify(sortKeys(modules), null, 2)}\n`)
