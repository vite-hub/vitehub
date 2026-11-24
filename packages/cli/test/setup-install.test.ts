import { chmod, readFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import process from "node:process"

import { describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"
import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupAddPlan } from "../src/setup/index.ts"

const preview = "https://pkg.pr.new/vite-hub/vitehub/@vite-hub/database@3476"
const orm = "drizzle-orm@1.0.0-rc.5 || ^1.0.0"
const kit = "drizzle-kit@1.0.0-rc.5 || ^1.0.0"

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
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages).toEqual([preview, orm])
    expect(result.json.install.devPackages).toEqual([kit])
    expect(result.json.install.command).toContain(`${preview} "${orm}"`)
    expect(spawn.mock.calls).toEqual([
      [manager, [manager === "npm" ? "install" : "add", preview, orm], expect.any(Object)],
      [manager, [manager === "npm" ? "install" : "add", manager === "bun" ? "-d" : "-D", kit], expect.any(Object)],
    ])
  })

  it("passes both ranges intact through the package manager shim", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "app", packageManager: "npm@11.0.0", type: "module" }),
      "vite.config.ts": viteConfig('{ host: "node" }'),
      "capture.cjs": `require("node:fs").appendFileSync("args.log", JSON.stringify(process.argv.slice(2)) + "\\n")`,
      "npm.cmd": `@"${process.execPath}" capture.cjs %*\r\n`,
      "npm": `#!/bin/sh\nexec "${process.execPath}" capture.cjs "$@"\n`,
    })
    await chmod(join(root, "npm"), 0o755)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"))
    const exitCode = await runViteHubCli({
      args: ["add", "database", "--yes", "--json"],
      cwd: root,
      env: { ...env, PATH: [root, process.env.PATH].join(delimiter) },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    })
    expect(exitCode).toBe(0)
    const args = (await readFile(join(root, "args.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    expect(args).toEqual([["install", preview, orm], ["install", "-D", kit]])
  })
})
