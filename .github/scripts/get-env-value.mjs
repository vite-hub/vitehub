#!/usr/bin/env node
// Reads a dotenv file and writes the value of a single key to stdout.
// Handles double/single quoted values. Used by manual-live-e2e workflow.

import { readFileSync } from "node:fs"

const [file, key] = process.argv.slice(2)
if (!file || !key) {
  console.error("usage: get-env-value.mjs <file> <key>")
  process.exit(2)
}

for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.startsWith(`${key}=`)) continue
  let value = line.slice(key.length + 1)
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      if (first === "\"") {
        try { value = JSON.parse(value) }
        catch { value = value.slice(1, -1) }
      }
      else {
        value = value.slice(1, -1)
      }
    }
  }
  process.stdout.write(value)
  process.exit(0)
}
