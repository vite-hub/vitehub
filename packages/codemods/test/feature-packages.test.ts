import { existsSync } from "node:fs"
import { cp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { featureIds, features } from "@vite-hub/internal/features"
import { kebabCase } from "scule"
import { glob } from "tinyglobby"
import { afterAll, expect, it } from "vitest"

import { runCodemod } from "../src/index.ts"
import { findViteHubOption } from "../src/shared/config-editor.ts"
import { literalValue, readNuxtConfig } from "../src/shared/nuxt-config.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtures = join(packageRoot, "test/fixtures")
const scratch = join(packageRoot, ".tmp/feature-packages-test")

const catalog: Record<string, readonly string[]> = { ...Object.fromEntries(featureIds.map(id => [id, features[id].packages])), content: ["@vite-hub/content"] }

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function enabledFeatures(cwd: string): Promise<[string, readonly string[]][]> {
  const config = await readNuxtConfig(cwd)
  const imported = new Set<string>()
  for (const file of await glob(["**/*.{ts,mts,js,mjs,vue}"], { cwd, ignore: ["**/node_modules/**", "nuxt.config.*"] })) {
    for (const match of (await readFile(join(cwd, file), "utf8")).matchAll(/["']vite-hub\/(?<name>[\w-]+)/g)) imported.add(match.groups?.name ?? "")
  }
  return Object.entries(catalog).filter(([id]) => {
    const option = findViteHubOption(config, id)
    if (option) return literalValue(option.value) !== false
    const discovered = featureIds.find(feature => feature === id)
    return imported.has(kebabCase(id)) || (discovered ? features[discovered].enabledByDiscovery ?? [] : []).some(entry => existsSync(join(cwd, "server", entry)))
  })
}

it.each([
  ["nuxt-resend", "resend"],
  ["resend-sdk", "resend"],
  ["nuxt-cron", "nuxt-cron"],
  ["nuxt-cron-partial", "nuxt-cron"],
  ["nuxt-better-auth", "nuxt-better-auth"],
  ["nuxt-content", "nuxt-content"],
  ["t3-env", "t3-env"],
  ["env-schema", "nuxt-safe-runtime-config"],
  ["valibot-schema", "nuxt-safe-runtime-config"],
  ["nuxthub-starter", "nuxthub"],
  ["nuxthub-chat", "nuxthub"],
  ["nuxthub-atinotes", "nuxthub"],
])("%s: the %s codemod adds the ViteHub packages of each feature that its output turns on", async (fixture, codemod) => {
  const cwd = join(scratch, fixture)
  await rm(cwd, { recursive: true, force: true })
  await cp(join(fixtures, fixture, "input"), cwd, { recursive: true })
  await runCodemod(codemod, { cwd })
  const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))
  const listed = { ...manifest.dependencies, ...manifest.devDependencies }
  const enabled = await enabledFeatures(cwd)
  expect(enabled.length).toBeGreaterThan(0)
  expect(enabled.flatMap(([id, packages]) => packages.filter(name => name.startsWith("@vite-hub/") && !(name in listed)).map(name => `${id}: ${name}`))).toEqual([])
})

it.each([
  ["nuxt-resend", "resend", "0.4.1", { "@vite-hub/email": "0.4.1" }],
  ["nuxt-cron", "nuxt-cron", "0.4.1", { "@vite-hub/schedule": "0.4.1", "@vite-hub/kv": "0.4.1" }],
  ["nuxt-resend", "resend", "~0.4.1", { "@vite-hub/email": "~0.4.1" }],
  ["resend-sdk", "resend", "https://pkg.pr.new/vite-hub/vitehub/vite-hub@71fa186", { "@vite-hub/email": "https://pkg.pr.new/vite-hub/vitehub/@vite-hub/email@71fa186" }],
])("%s: new feature packages match the app's ViteHub release", async (fixture, codemod, specifier, owners) => {
  const cwd = join(scratch, `${fixture}-${encodeURIComponent(specifier)}`)
  await rm(cwd, { recursive: true, force: true })
  await cp(join(fixtures, fixture, "input"), cwd, { recursive: true })
  const path = join(cwd, "package.json")
  const manifest = JSON.parse(await readFile(path, "utf8"))
  manifest.devDependencies = { "vite-hub": specifier }
  await writeFile(path, JSON.stringify(manifest))
  await runCodemod(codemod, { cwd })
  const migrated = JSON.parse(await readFile(path, "utf8"))
  expect(migrated.devDependencies["vite-hub"]).toBe(specifier)
  expect(migrated.dependencies).toMatchObject(owners)
})

it("leaves the app unchanged when it cannot match the existing ViteHub specifier", async () => {
  const cwd = join(scratch, "nuxt-resend-unmatched")
  await rm(cwd, { recursive: true, force: true })
  await cp(join(fixtures, "nuxt-resend", "input"), cwd, { recursive: true })
  const path = join(cwd, "package.json")
  const manifest = JSON.parse(await readFile(path, "utf8"))
  manifest.dependencies["vite-hub"] = "file:../vite-hub"
  const before = JSON.stringify(manifest)
  await writeFile(path, before)
  const config = await readFile(join(cwd, "nuxt.config.ts"), "utf8")
  await expect(runCodemod("resend", { cwd })).rejects.toThrow("Update vite-hub in package.json")
  expect(await readFile(path, "utf8")).toBe(before)
  expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
})
