import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect, it } from "vitest"

const packageRoot = resolve(import.meta.dirname, "..")

// Generated code imports `ownModule()` paths from `dist/`. In this repository they resolve to `src/` too, so a
// path that is not a build entry passes every local test and breaks only in an installed package.
it("builds every module that generated code imports with ownModule()", () => {
  const config = readFileSync(join(packageRoot, "vite.config.ts"), "utf8")
  const exports = JSON.stringify(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).exports)
  const files = readdirSync(join(packageRoot, "src"), { recursive: true, encoding: "utf8" }).filter(file => /\.(?:ts|mts)$/.test(file))
  const targets = new Set(files.flatMap(file => [...readFileSync(join(packageRoot, "src", file), "utf8").matchAll(/ownModule\(import\.meta\.url, "([^"]+)"\)/g)].map(match => match[1]!)))
  expect(targets.size).toBeGreaterThan(0)
  const missing = [...targets].filter(target => !config.includes(`"src/${target}.ts"`) && !exports.includes(`"./dist/${target}.js"`))
  expect(missing, "Add these paths to runtimeEntries in packages/vite-hub/vite.config.ts.").toEqual([])
})
