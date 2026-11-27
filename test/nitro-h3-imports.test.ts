import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")

const exceptions: Readonly<Record<string, string>> = {
  "packages/internal/src/runtime/vercel-hosted.ts": "The Vercel server of a Vite app without Nitro. It builds its own H3 app.",
}

const peerExceptions: Readonly<Record<string, string>> = {
  "packages/docs": "A Nuxt layer for docs sites. The Nuxt app that extends it installs Nitro.",
}

const valueImport = /^(?:import|export)\s+(?!type\b)[^'"]*?\bfrom\s*["']h3["']/m
const nitroH3Import = /\bfrom\s*["']nitro\/h3["']/

const sources = execFileSync("git", ["ls-files", "--", "packages/*/src/*"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter(file => /^packages\/[^/]+\/src\/.+\.(?:m?ts|vue)$/.test(file) && !/\.(?:test|test-d|d)\.m?ts$/.test(file))
  .map(file => ({ file, code: readFileSync(join(repoRoot, file), "utf8") }))

it("imports H3 values through nitro/h3", () => {
  const found = sources.filter(({ file, code }) => !exceptions[file] && valueImport.test(code)).map(({ file }) => file)
  expect(found).toEqual([])
})

it("declares nitro as a peer of each package that imports nitro/h3", () => {
  const packages = new Set(sources.filter(({ code }) => nitroH3Import.test(code)).map(({ file }) => file.split("/").slice(0, 2).join("/")))
  const missing = [...packages].filter((dir) => {
    if (peerExceptions[dir]) return false
    const manifest = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> }
    return !manifest.peerDependencies?.nitro
  })
  expect(missing).toEqual([])
})
