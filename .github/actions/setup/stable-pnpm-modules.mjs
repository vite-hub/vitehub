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
