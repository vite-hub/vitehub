import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"
import { runViteHubCli } from "@vite-hub/cli"

import { loadViteHubCliConfig } from "../src/internal/cli-config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(config: "nuxt" | "vite") {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cli-config-"))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${config}.config.ts`), "export default {}\n", "utf8")
  return root
}

describe("ViteHub CLI config loading", () => {
  it("loads Nuxt Vite options when Nuxt is the project config owner", async () => {
    const root = await createProject("nuxt")
    const close = vi.fn()
    const loadNuxt = vi.fn(async () => ({
      close,
      options: {
        rootDir: root,
        vite: { plugins: [{ name: "nuxt-vitehub" }] },
      },
    }))
    const resolveViteConfig = vi.fn(async config => ({
      plugins: config.plugins || [],
      root: String(config.root),
    }))

    await expect(loadViteHubCliConfig(root, "serve", { loadNuxt, resolveViteConfig })).resolves.toEqual({
      plugins: [{ name: "nuxt-vitehub" }],
      root,
      vitehubConfigResolved: true,
    })
    expect(resolveViteConfig).toHaveBeenCalledWith(expect.objectContaining({
      configFile: false,
      root,
      vitehubCliDiscovery: true,
    }), "serve", "development")
    expect(loadNuxt).toHaveBeenCalledWith({
      cwd: root,
      dev: true,
      overrides: { devtools: { enabled: false }, vitehubCliDiscovery: true },
      ready: true,
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it("resolves Nuxt's configured Vite root for CLI discovery", async () => {
    const root = await createProject("nuxt")
    const close = vi.fn()
    const loadNuxt = vi.fn(async () => ({
      close,
      options: {
        rootDir: root,
        vite: { root: "app", plugins: [{ name: "nuxt-vitehub" }] },
      },
    }))
    const resolveViteConfig = vi.fn(async config => ({
      plugins: config.plugins || [],
      root: String(config.root),
    }))

    await expect(loadViteHubCliConfig(root, "serve", { loadNuxt, resolveViteConfig })).resolves.toEqual({
      plugins: [{ name: "nuxt-vitehub" }],
      root: join(root, "app"),
      vitehubConfigResolved: true,
    })
    expect(resolveViteConfig).toHaveBeenCalledWith(expect.objectContaining({
      configFile: false,
      root: join(root, "app"),
      vitehubCliDiscovery: true,
    }), "serve", "development")
    expect(close).toHaveBeenCalledOnce()
  })

  it("keeps explicit Vite config ownership", async () => {
    const root = await createProject("vite")
    const loadNuxt = vi.fn()
    const resolveViteConfig = vi.fn(async config => ({ plugins: [], root: String(config.root) }))

    await expect(loadViteHubCliConfig(root, "serve", { loadNuxt, resolveViteConfig })).resolves.toEqual({
      plugins: [],
      root,
      vitehubConfigResolved: true,
    })

    expect(loadNuxt).not.toHaveBeenCalled()
    expect(resolveViteConfig).toHaveBeenCalledWith({ root, vitehubCliDiscovery: true }, "serve", "development")
  })

  it("uses Nuxt ownership when a Nuxt app also has a Vite config", async () => {
    const root = await createProject("vite")
    await writeFile(join(root, "nuxt.config.ts"), "export default {}\n", "utf8")
    const close = vi.fn()
    const loadNuxt = vi.fn(async () => ({
      close,
      options: {
        rootDir: root,
        vite: { plugins: [{ name: "nuxt-vitehub" }] },
      },
    }))
    const loadNuxtViteConfig = vi.fn()
    const resolveViteConfig = vi.fn(async config => ({ plugins: [], root: String(config.root) }))

    await runViteHubCli({
      args: ["--help"],
      cwd: root,
      loadConfig: (directory, command) => loadViteHubCliConfig(directory, command, { loadNuxt, resolveViteConfig }),
      loadNuxtViteConfig,
      stdout: { write: () => true },
    })

    expect(loadNuxt).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(loadNuxtViteConfig).not.toHaveBeenCalled()
  })
})

describe("shipped ViteHub CLI production discovery", () => {
  const execFileAsync = promisify(execFile);
  const bin = resolve(import.meta.dirname, "../dist/bin.js");

  it("inspects build-only Vite output through the framework entrypoint", async () => {
    const root = await createProject("vite");
    await writeFile(
      join(root, "vite.config.ts"),
      `
export default ({ command, mode }) => ({
  plugins: command === "build" && mode === "production" ? [{
    apply: "build",
    name: "production-output",
    vitehub: { inspect: { providerOutput: [{ owner: "test", path: ${JSON.stringify(join(root, ".vitehub/production.json"))} }] } },
  }] : [],
})
`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [bin, "inspect", "provider-output", "--json"],
      { cwd: root },
    );
    expect(JSON.parse(stdout).providerOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "test", path: ".vitehub/production.json" }),
      ]),
    );
  });

  it("inspects production-only Nuxt output through the framework entrypoint", async () => {
    const root = await createProject("nuxt");
    await mkdir(join(root, "node_modules"));
    await symlink(
      resolve(import.meta.dirname, "../../cli/node_modules/nuxt"),
      join(root, "node_modules/nuxt"),
      "dir",
    );
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(
      join(root, "nuxt.config.ts"),
      `export default { modules: ["./production-module.ts"] }`,
    );
    await writeFile(
      join(root, "production-module.ts"),
      `
export default function (_options, nuxt) {
  if (nuxt.options.vitehubCliDiscovery !== true) throw new Error("Missing CLI discovery marker")
  if (nuxt.options.devtools.enabled) throw new Error("CLI discovery enabled DevTools")
  if (nuxt.options.dev) return
  nuxt.options.vite.plugins ||= []
  nuxt.options.vite.plugins.push({
    apply: "build",
    name: "production-output",
    vitehub: { inspect: { providerOutput: [{ owner: "test", path: ${JSON.stringify(join(root, ".vitehub/nuxt-production.json"))} }] } },
  })
}
`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [bin, "inspect", "provider-output", "--json"],
      { cwd: root },
    );
    expect(JSON.parse(stdout).providerOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "test", path: ".vitehub/nuxt-production.json" }),
      ]),
    );
  }, 30_000);
});
