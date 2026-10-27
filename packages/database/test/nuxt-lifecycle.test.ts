import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
// Use the workspace's installed Nuxt for the framework lifecycle check.
const nuxtPackage = createRequire(new URL("../../../docs/package.json", import.meta.url)).resolve("nuxt/package.json")
const nuxtCli = createRequire(nuxtPackage).resolve("@nuxt/cli/cli")

it.each(["default", "orders"])("preserves the %s Database alias through Nuxt prepare cleanup", async (name) => {
  const root = await mkdtemp(join(packageRoot, ".vitest-nuxt-lifecycle-"))
  const buildDir = join(root, ".nuxt")
  const aliasFile = join(root, "database-alias.json")
  try {
    await mkdir(join(root, "node_modules"), { recursive: true })
    await symlink(dirname(nuxtPackage), join(root, "node_modules/nuxt"), "dir")
    await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
    const definition = join(root, "server/databases", ...(name === "default" ? [] : [name]), "config.ts")
    await mkdir(dirname(definition), { recursive: true })
    await writeFile(definition, `export default defineDatabase({ name: ${JSON.stringify(name)}, schema: {} })\n`)
    await writeFile(join(root, "nuxt.config.ts"), [
      'import { writeFile } from "node:fs/promises"',
      `import { hubDb } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/nuxt.ts")).href)}`,
      "export default defineNuxtConfig({",
      `  buildDir: ${JSON.stringify(buildDir)},`,
      "  dev: false, devtools: { enabled: false }, telemetry: false,",
      "  modules: [hubDb()], nitro: { preset: 'node-server' },",
      "  hooks: {",
      "    'nitro:init': async (nitro) => {",
      `      await writeFile(${JSON.stringify(aliasFile)}, JSON.stringify(nitro.options.alias['@vite-hub/database/drizzle']))`,
      "    },",
      "  },",
      "})",
    ].join("\n"))

    // Real CLI prepare initializes Nitro, clears buildDir, then generates Nuxt templates without bundling.
    await execFileAsync(process.execPath, [nuxtCli, "prepare", root], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", NUXT_TELEMETRY_DISABLED: "1" },
      timeout: 30_000,
    })
    const runtime: string = JSON.parse(await readFile(aliasFile, "utf8"))
    const source = await readFile(runtime, "utf8")
    expect(source).toContain(`[${JSON.stringify(name)}]: {`)
    expect(source).toContain("export function useDatabase")
    await expect(readFile(join(buildDir, "nuxt.d.ts"), "utf8")).resolves.toContain("reference")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)
