import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"

import type { ViteHubCliSeed, ViteHubCliSeedOptions } from "@vite-hub/internal/cli"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => (value += String(chunk), true) }
}

/** A seed that records its options and returns `code`, or `undefined` like a primitive without seed files. */
function seed(name: string, code: number | undefined, calls: Array<[string, ViteHubCliSeedOptions]>): ViteHubCliSeed {
  return { files: `server/seed/${name}/`, name, run: vi.fn(async (options) => {
    calls.push([name, options])
    return code
  }) }
}

async function run(args: string[], seeds: ViteHubCliSeed[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  const stdout = stream()
  const stderr = stream()
  const cwd = options.cwd ?? "/repo"
  const exitCode = await runViteHubCli({
    args,
    cwd,
    env: options.env ?? {},
    loadConfig: async () => ({ plugins: [{ vitehub: { cli: { namespaces: [], publicUrl: "https://app.example", seeds } } }], root: cwd }),
    stderr,
    stdout,
  })
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

describe("vitehub seed", () => {
  it("runs every seed with local data by default", async () => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    const result = await run(["seed"], [seed("database", 0, calls), seed("kv", 0, calls), seed("blob", undefined, calls)])
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(calls.map(([name, options]) => [name, options.remote, options.url])).toEqual([["database", false, undefined], ["kv", false, undefined], ["blob", false, undefined]])
  })

  it("runs only the named primitives, and writes the deployed app with --remote", async () => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    const seeds = [seed("database", 0, calls), seed("kv", 0, calls), seed("blob", 0, calls)]
    await expect(run(["seed", "kv", "blob", "--remote", "--timeout", "5000"], seeds)).resolves.toMatchObject({ exitCode: 0 })
    expect(calls.map(([name, options]) => [name, options.remote, options.url, options.timeout])).toEqual([["kv", true, "https://app.example", 5000], ["blob", true, "https://app.example", 5000]])

    calls.length = 0
    await expect(run(["seed", "kv", "--remote", "--url", "https://staging.example"], seeds)).resolves.toMatchObject({ exitCode: 0 })
    expect(calls.map(([name, options]) => [name, options.url])).toEqual([["kv", "https://staging.example"]])
  })

  it("passes --database to the Database seed only", async () => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    await expect(run(["seed", "--database", "analytics"], [seed("database", 0, calls), seed("kv", 0, calls)])).resolves.toMatchObject({ exitCode: 0 })
    expect(calls.map(([name, options]) => [name, options.database])).toEqual([["database", "analytics"]])
  })

  it("stops at the first seed that fails", async () => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    const result = await run(["seed"], [seed("database", 1, calls), seed("kv", 0, calls)])
    expect(result.exitCode).toBe(1)
    expect(calls.map(([name]) => name)).toEqual(["database"])
  })

  it("names the seed folders when there is nothing to seed", async () => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    const seeds = [seed("database", undefined, calls), seed("kv", undefined, calls)]
    const all = await run(["seed"], seeds)
    expect(all.exitCode).toBe(1)
    expect(all.stderr).toBe("[vitehub] Nothing to seed. Add seed files:\n  database  server/seed/database/\n  kv        server/seed/kv/\n")

    // A named primitive must have seed files, even when another one seeds data.
    const named = await run(["seed", "kv"], [seed("database", 0, calls), seed("kv", undefined, calls)])
    expect(named.exitCode).toBe(1)
    expect(named.stderr).toContain("  kv        server/seed/kv/")
  })

  it.each([
    [["seed", "redis"], "Unknown seed: redis. Seeds of this app: database, kv."],
    [["seed", "--url", "https://app.example"], "--url names a deployed app. Add --remote to write its data."],
    [["seed", "kv", "--database", "analytics"], "--database seeds only the Database. Remove the other primitive names."],
    [["seed", "--timeout", "soon"], "--timeout must be a positive integer of milliseconds."],
    [["seed", "--force"], "Unknown option: --force"],
  ])("refuses %j", async (args, message) => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    const result = await run(args, [seed("database", 0, calls), seed("kv", 0, calls)])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`[vitehub] ${message}\n`)
    expect(result.stderr).toContain("Usage: vitehub seed")
    expect(calls).toEqual([])
  })

  it("loads the env files of --stage for every seed and restores the environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-cli-seed-"))
    directories.push(cwd)
    await writeFile(join(cwd, ".env.staging"), "SEED_STAGE_VALUE=staging\nSEED_SHELL_VALUE=file\n")
    const seen: Array<string | undefined> = []
    const stageSeed: ViteHubCliSeed = { files: "server/seed/kv/", name: "kv", run: async (options) => {
      seen.push(options.env.SEED_STAGE_VALUE, process.env.SEED_STAGE_VALUE, options.env.SEED_SHELL_VALUE)
      return 0
    } }
    await expect(run(["seed", "--stage", "staging"], [stageSeed], { cwd, env: { SEED_SHELL_VALUE: "shell" } })).resolves.toMatchObject({ exitCode: 0 })
    expect(seen).toEqual(["staging", "staging", "shell"])
    expect(process.env.SEED_STAGE_VALUE).toBeUndefined()
  })

  it.each([["--stage", "staging"], ["--stage=staging"]])("loads the project in the mode of %s, so --remote writes that deployment", async (...stageArgs) => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    const kv = seed("kv", 0, calls)
    const modes: Array<string | undefined> = []
    const exitCode = await runViteHubCli({
      args: ["seed", "kv", "--remote", ...stageArgs],
      cwd: "/repo",
      env: {},
      loadConfig: async (_root, _command, mode) => {
        modes.push(mode)
        const publicUrl = mode === "staging" ? "https://staging.example" : "https://production.example"
        return { plugins: [{ vitehub: { cli: { namespaces: [], publicUrl, seeds: [kv] } } }], root: "/repo" }
      },
      stderr: stream(),
      stdout: stream(),
    })
    expect(exitCode).toBe(0)
    expect(modes).toEqual(["staging"])
    expect(calls.map(([, options]) => options.url)).toEqual(["https://staging.example"])
  })

  it("lists the seed folders in its help", async () => {
    const calls: Array<[string, ViteHubCliSeedOptions]> = []
    const result = await run(["seed", "--help"], [seed("kv", 0, calls)])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Seed files:\n  kv        server/seed/kv/\n")
    expect(calls).toEqual([])
  })
})
