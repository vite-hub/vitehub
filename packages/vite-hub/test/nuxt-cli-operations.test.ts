import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runViteHubCli } from "@vite-hub/cli"
import { resolveConfig, type InlineConfig, type PluginOption } from "vite"
import { afterEach, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import viteHubNuxtModule from "../src/nuxt.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vitehub-${name}-cli-operations-`))
  roots.push(root)
  await mkdir(join(root, "server/agents"), { recursive: true })
  await writeFile(join(root, "server/agents/support.ts"), "export default {}\n", "utf8")
  await writeFile(join(root, "package.json"), JSON.stringify({ name }), "utf8")
  return root
}

/** The plugins that `nuxt.options.vite` holds after the ViteHub module ran in CLI discovery, as `loadNuxt()` leaves them. */
async function nuxtPlugins(root: string): Promise<PluginOption[]> {
  const nuxt = {
    hook() {},
    options: {
      buildDir: join(root, ".nuxt"),
      dev: true,
      rootDir: root,
      serverDir: join(root, "server"),
      srcDir: join(root, "app"),
      vite: { define: {}, plugins: [] as PluginOption[] },
      vitehubCliDiscovery: true as const,
    },
  }
  await viteHubNuxtModule({ agent: true, console: true, host: "node" }, nuxt)
  return nuxt.options.vite.plugins
}

/** Run the CLI as it runs in a Vite project (`vite.config.ts`) or a Nuxt project (`nuxt.config.ts`). */
async function cli(framework: "nuxt" | "vite", args: string[]) {
  const root = await createProject(framework)
  const plugins = framework === "vite" ? [vitehub({ agent: true, console: true, env: false, host: "node" })] : await nuxtPlugins(root)
  const resolve = async (command: "build" | "serve") => await resolveConfig({ configFile: false, logLevel: "silent", plugins, root } satisfies InlineConfig, command)
  let stderr = ""
  let stdout = ""
  const exitCode = await runViteHubCli({
    args,
    cwd: root,
    loadConfig: async (_directory, command) => framework === "vite"
      ? { ...await resolve(command), vitehubConfigResolved: true }
      // A Nuxt project has no Vite config of its own. The CLI then reads the plugins of the Nuxt Vite config.
      : { plugins: [], root },
    loadNuxtViteConfig: async (_directory, command) => framework === "nuxt" ? await resolve(command) : undefined,
    stderr: { write: chunk => (stderr += String(chunk), true) },
    stdout: { write: chunk => (stdout += String(chunk), true) },
  })
  return { exitCode, stderr, stdout }
}

// The Console is on, as in an app that the Console inspects.
it.each(["vite", "nuxt"] as const)("finds the Console operation commands in a %s project", async (framework) => {
  const result = await cli(framework, ["invocations", "--help"])

  expect(result.stderr).toBe("")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("Usage: vitehub invocations <feature> [args...]")
  expect(result.stdout).toMatch(/^ {2}list\b/m)
  expect(result.stdout).toMatch(/^ {2}cancel\b/m)
}, 60_000)
