import { describe, expect, it, vi } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupAddPlan } from "../src/setup/index.ts"

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] instanceof URL && args[0].href === import.meta.resolve("@vite-hub/cli/package.json")) {
        return JSON.stringify({ dependencies: { "@vite-hub/runtime": "https://pkg.pr.new/vite-hub/vitehub/@vite-hub/runtime@3476" } })
      }
      return fs.readFileSync(...args)
    },
  }
})

describe("preview setup installs", () => {
  it.each(["pnpm", "npm", "yarn", "bun"])("keeps ViteHub packages on the CLI preview with %s", async (manager) => {
    const root = await createProject({
      "package.json": JSON.stringify({ ...JSON.parse(pnpmManifest), packageManager: `${manager}@1.0.0` }),
      "vite.config.ts": viteConfig('{ host: "node" }'),
    })
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const result = await runSetup<SetupAddPlan>(["add", "database", "--yes", "--json"], root, {}, { spawn })
    const specifier = "https://pkg.pr.new/vite-hub/vitehub/@vite-hub/database@3476"
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages).toEqual([specifier, "drizzle-orm"])
    expect(result.json.install.command).toContain(specifier)
    expect(spawn.mock.calls).toEqual([
      [manager, [manager === "npm" ? "install" : "add", specifier, "drizzle-orm"], expect.any(Object)],
      [manager, [manager === "npm" ? "install" : "add", manager === "bun" ? "-d" : "-D", "drizzle-kit"], expect.any(Object)],
    ])
  })
})
