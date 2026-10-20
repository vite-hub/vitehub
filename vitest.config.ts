import { existsSync, readFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

import { testLayerIncludes } from "./test/layers.ts"

// This config runs only root contracts. A package test needs the package
// config and package builds, so stop with the package commands instead of
// "No test files found".
const root = fileURLToPath(new URL(".", import.meta.url))
const packageDirectory = process.argv.slice(2)
  .map(argument => relative(root, resolve(argument)).split(sep))
  .find(([first, name]) => first === "packages" && name)?.slice(0, 2).join("/")
if (packageDirectory) {
  const manifestPath = resolve(root, packageDirectory, "package.json")
  const manifest: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined
  const name = typeof manifest === "object" && manifest !== null && "name" in manifest ? String(manifest.name) : "<package name>"
  throw new Error([
    "Root Vitest runs only root contracts (test/*.test.ts). Run package tests from the package:",
    `  corepack pnpm --dir ${packageDirectory} run test`,
    `  corepack pnpm exec vp run --cache -t ${name}#build && corepack pnpm --dir ${packageDirectory} exec vp test <file relative to ${packageDirectory}>`,
  ].join("\n"))
}

export default defineConfig({
  test: {
    environment: "node",
    include: testLayerIncludes.contracts,
  },
})
