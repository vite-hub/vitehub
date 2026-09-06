import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  hasNitroConfigContext,
  resolveNitroVercelFunctionName,
  resolveViteHubGeneratedRoot,
  resolveViteHubProjectRoot,
  VITEHUB_GENERATED_ROOT,
  VITEHUB_NITRO_CONFIG_CONTEXT,
} from "../src/build/vite.ts"

describe("Vite provider builds", () => {
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

  it("resolves the shared generated-artifact root", () => {
    expect(resolveViteHubGeneratedRoot({ root: "/app" })).toBe("/app/.vitehub")
    expect(resolveViteHubGeneratedRoot({
      [VITEHUB_GENERATED_ROOT]: "/app/.nuxt/vitehub",
      root: "/app",
    })).toBe("/app/.nuxt/vitehub")
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
