import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryNodeModules = resolve(import.meta.dirname, "../../../../node_modules")

export async function nuxtFixture(): Promise<{ app: string, root: string }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-nuxt-nitro-"))
  const nuxtPackage = join(root, "node_modules/nuxt")
  await mkdir(join(nuxtPackage, "node_modules"), { recursive: true })
  await writeFile(join(nuxtPackage, "package.json"), JSON.stringify({ name: "nuxt", version: "5.0.0", dependencies: { nitro: "3.0.0" } }))
  await symlink(join(repositoryNodeModules, "nitro"), join(nuxtPackage, "node_modules/nitro"), "dir")
  const app = join(root, "app")
  await mkdir(join(app, "server"), { recursive: true })
  await symlink(repositoryNodeModules, join(app, "node_modules"), "dir")
  await writeFile(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }))
  return { app, root }
}

export function createNuxt(app: string, dev: boolean) {
  const nitroConfigHooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
  const modulesDoneHooks: Array<() => void> = []
  const nuxt = {
    callHook: async () => {},
    hook(name: string, callback: (...args: never[]) => unknown) {
      if (name === "nitro:config") nitroConfigHooks.push(callback as (config: Record<string, unknown>) => Promise<void>)
      if (name === "modules:done") modulesDoneHooks.push(callback as () => void)
    },
    options: {
      _installedModules: [],
      alias: {} as Record<string, string>,
      app: { baseURL: "/" },
      buildDir: join(app, ".nuxt"),
      dev,
      experimental: { nitroViteEnvironment: false },
      nitro: {} as Record<string, unknown> & { alias?: Record<string, string> },
      plugins: [],
      rootDir: app,
      routeRules: {},
      router: { options: {} },
      serverDir: join(app, "server"),
      srcDir: app,
      vite: { plugins: [] },
    },
  }
  return {
    nuxt,
    async nitroConfig(): Promise<Record<string, unknown>> {
      for (const hook of modulesDoneHooks) hook()
      const config: Record<string, unknown> = {
        ...nuxt.options.nitro,
        alias: { ...nuxt.options.alias, ...nuxt.options.nitro.alias },
        buildDir: join(app, ".nuxt/nitro"),
        dev,
        output: { dir: join(app, ".output") },
        rootDir: app,
        serverDir: join(app, "server"),
      }
      for (const hook of nitroConfigHooks) await hook(config)
      return config
    },
  }
}

export async function buildNitro(config: Record<string, unknown>): Promise<void> {
  const { build, createNitro, prepare } = await import("nitro/builder")
  const nitro = await createNitro({ ...config, preset: "standard" })
  try {
    await prepare(nitro)
    await build(nitro)
  }
  finally {
    await nitro.close()
  }
}
