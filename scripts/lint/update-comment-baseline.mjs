import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { areaOf, baselineDir } from "./comments.mjs"
import { bannedComments } from "./delete-comments.mjs"

const areas = new Map()
for (const [file, spans] of [...bannedComments(["."])].sort(([a], [b]) => a.localeCompare(b))) {
  const area = areas.get(areaOf(file)) ?? {}
  area[file] = spans.length
  areas.set(areaOf(file), area)
}

mkdirSync(baselineDir, { recursive: true })
for (const name of readdirSync(baselineDir)) {
  if (!areas.has(name.replace(/\.json$/, ""))) rmSync(join(baselineDir, name))
}
let total = 0
for (const [area, counts] of areas) {
  writeFileSync(join(baselineDir, `${area}.json`), `${JSON.stringify(counts, null, 2)}\n`)
  total += Object.values(counts).reduce((sum, count) => sum + count, 0)
}
console.log(`The baseline allows ${total} comments in ${areas.size} areas.`)
