import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { mergeConfig } from "vite"

import {
  createNoExternalMerger,
  createNoExternalAddition,
  generatedViteHubWatchIgnoredAddition,
  hasNitroConfigContext,
  resolveNitroVercelFunctionName,
  resolveViteHubGeneratedRoot,
  resolveViteHubProjectRoot,
  VITEHUB_GENERATED_ROOT,
  VITEHUB_NITRO_CONFIG_CONTEXT,
} from "../src/build/vite.ts"

describe("Vite provider builds", () => {
  it("merges a package into existing noExternal values", () => {
    const merge = createNoExternalMerger("@vite-hub/blob")
    expect(merge(undefined)).toEqual(["@vite-hub/blob"])
    expect(merge("existing")).toEqual(["existing", "@vite-hub/blob"])
    expect(merge(["existing", "@vite-hub/blob"])).toEqual(["existing", "@vite-hub/blob"])
    expect(merge(true)).toBe(true)
  })

  it("preserves scalar and array noExternal entries across plugin config merges", () => {
    const existingPattern = /existing/
    for (const noExternal of [undefined, "existing", existingPattern, ["existing", existingPattern]]) {
      let config = { ssr: { noExternal } }
      for (const packageName of ["@vite-hub/auth", "@vite-hub/workspace", "@vite-hub/auth"]) {
        config = mergeConfig(config, { ssr: { noExternal: createNoExternalAddition(packageName)(config.ssr.noExternal) } })
      }
      expect(config.ssr.noExternal).toEqual([
        ...(noExternal === undefined ? [] : Array.isArray(noExternal) ? noExternal : [noExternal]),
        "@vite-hub/auth",
        "@vite-hub/workspace",
      ])
    }
    expect(mergeConfig({ ssr: { noExternal: true } }, {
      ssr: { noExternal: createNoExternalAddition("@vite-hub/auth")(true) },
    }).ssr.noExternal).toBe(true)
  })

  it("preserves scalar watch matchers and adds the generated ignore only once", () => {
    const existingPattern = /existing/
    const existingPredicate = (path: string) => path.includes("existing")
    for (const ignored of [undefined, "**/existing/**", existingPattern, existingPredicate, ["**/existing/**", existingPattern, existingPredicate]]) {
      let config = { server: { watch: { ignored } } }
      for (let plugin = 0; plugin < 3; plugin++) {
        config = mergeConfig(config, { server: { watch: { ignored: generatedViteHubWatchIgnoredAddition(config.server.watch.ignored) } } })
      }
      expect(config.server.watch.ignored).toEqual([
        ...(ignored === undefined ? [] : Array.isArray(ignored) ? ignored : [ignored]),
        "**/.vitehub/**",
      ])
    }
  })

  it("continues project discovery above a repository-local temporary directory", async () => {
    const previousTemporaryDirectories = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
    }
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-project-root-boundary-"))
    const temporaryRoot = join(projectRoot, ".tmp")
    const nestedRoot = join(temporaryRoot, "fixture")
    try {
      await mkdir(nestedRoot, { recursive: true })
      await writeFile(join(projectRoot, "package.json"), '{"private":true}\n')
      process.env.TEMP = temporaryRoot
      process.env.TMP = temporaryRoot
      process.env.TMPDIR = temporaryRoot

      expect(resolveViteHubProjectRoot(nestedRoot)).toBe(projectRoot)
      expect(resolveViteHubProjectRoot(nestedRoot, { projectRoot })).toBe(projectRoot)
    }
    finally {
      for (const [name, value] of Object.entries(previousTemporaryDirectories)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("keeps ordinary app packages at their nearest project marker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-app-project-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await Promise.all([
        writeFile(join(projectRoot, "package.json"), '{"private":true}\n'),
        writeFile(join(appRoot, "package.json"), '{"private":true}\n'),
      ])

      expect(resolveViteHubProjectRoot(appRoot)).toBe(appRoot)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("prefers a parent with ViteHub directories for app roots", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-app-parent-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await Promise.all([
        mkdir(join(projectRoot, "server", "agents"), { recursive: true }),
        writeFile(join(appRoot, "package.json"), '{"private":true}\n'),
      ])

      expect(resolveViteHubProjectRoot(appRoot)).toBe(projectRoot)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("prefers a Nuxt project root when app has its own package marker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-nuxt-app-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await Promise.all([
        writeFile(join(projectRoot, "package.json"), '{"private":true}\n'),
        writeFile(join(projectRoot, "nuxt.config.ts"), "export default {}\n"),
        writeFile(join(appRoot, "package.json"), '{"private":true}\n'),
      ])

      expect(resolveViteHubProjectRoot(appRoot)).toBe(projectRoot)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("resolves generated artifacts at the project root for nested Vite apps", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-generated-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await writeFile(join(projectRoot, "package.json"), '{"private":true}\n')

      expect(resolveViteHubGeneratedRoot({ root: appRoot })).toBe(join(projectRoot, ".vitehub"))
      expect(resolveViteHubGeneratedRoot({
        [VITEHUB_GENERATED_ROOT]: join(projectRoot, ".nuxt/vitehub"),
        root: appRoot,
      })).toBe(join(projectRoot, ".nuxt/vitehub"))
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("distinguishes the Nitro host plugin from ViteHub bridge plugins", () => {
    expect(hasNitroConfigContext({ plugins: [{ name: "nitro:main" }] })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [[false, [{ name: "nitro:main" }]]] })).toBe(true)
    expect(hasNitroConfigContext({ [VITEHUB_NITRO_CONFIG_CONTEXT]: true })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [{ name: "@vite-hub/blob/vite" }, { name: "@vite-hub/queue/vite" }] })).toBe(false)
    expect(hasNitroConfigContext({ plugins: [[{ name: "@vite-hub/blob/vite" }]] })).toBe(false)
  })

  it("isolates provider functions when Nitro owns the Vercel output", () => {
    const plugins = [{ name: "vitehub" }, { name: "nitro:main" }]

    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel" } }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "queue", { VERCEL: "1" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "workflow", { VITEHUB_HOSTING: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel" }, plugins: [{ name: "vitehub" }] }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({}, "workflow", { NITRO_PRESET: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({}, "queue", { SERVER_PRESET: "vercel-edge" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({
      environments: { client: { build: { outDir: ".vercel/output/static" } } },
      plugins,
    }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins: [{ name: "vitehub" }] }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({}, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", {})).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "cloudflare" } }, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
  })
})
