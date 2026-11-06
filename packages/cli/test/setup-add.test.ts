import { cp, readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { featureIds, featureSupport } from "@vite-hub/internal/features"
import { describe, expect, it } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { DeploymentPreset } from "@vite-hub/internal/deployment"
import type { SetupAddPlan, SetupError, SetupMissing, SetupStatus } from "../src/setup/index.ts"

const docsHosts = fileURLToPath(new URL("../../../fixtures/docs-hosts/", import.meta.url))

/** A temp copy of a `fixtures/docs-hosts` folder. */
async function copyFixture(name: string): Promise<string> {
  const root = await createProject()
  await cp(join(docsHosts, name), root, { recursive: true })
  return root
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  return Object.fromEntries(await Promise.all(files.map(async file => [relative(root, file), await readFile(file, "utf8")] as const)))
}

type AddResult = SetupAddPlan & { error?: SetupError, missing?: SetupMissing[], rerun?: string, snippet?: string }

function add(args: string[], root: string, spawn?: ViteHubCliSpawn) {
  return runSetup<AddResult>(["add", ...args, "--json"], root, {}, spawn)
}

const fixtures: ReadonlyArray<readonly [string, DeploymentPreset, string]> = [
  ["cloudflare", "cloudflare", "vite.config.ts"],
  ["vercel", "vercel", "vite.config.ts"],
  ["netlify", "netlify", "vite.config.ts"],
  ["deno", "deno", "vite.config.ts"],
  ["node-self-hosted", "node", "vite.config.ts"],
  ["installation", "node", "nuxt.config.ts"],
]

describe("vitehub add", () => {
  it.each(fixtures)("adds each native feature to a copy of docs-hosts/%s once", async (fixture, host, configFile) => {
    // `observability` has no default `service`, so it always needs input.
    const native = featureIds.filter(id => id !== "observability" && featureSupport(id, host).level === "native")
    expect(native.length).toBeGreaterThan(5)
    const files = Object.fromEntries(await Promise.all(["vite.config.ts", "nuxt.config.ts"].map(async file => [file, await readFile(join(docsHosts, fixture, file), "utf8").catch(() => undefined)] as const)))
    for (const id of native) {
      // Only the config files, so the loop stays fast on a slow temp disk.
      const root = await createProject(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined)))
      const before = await readFile(join(root, configFile), "utf8")
      const options = host === "node" && id === "schedule"
        ? ["--option", "schedule.runtime.driver=process"]
        : (host === "netlify" || host === "deno") && ["comments", "connections", "console"].includes(id)
            ? ["--option", "database.connection.url=libsql://example.com"]
            : []

      const first = await add([id, ...options, "--no-install", "--yes"], root)
      expect(first.exitCode, `${id}: ${first.stdout}`).toBe(0)
      expect(first.loadConfig).not.toHaveBeenCalled()
      const after = await readFile(join(root, configFile), "utf8")
      const status = (await runSetup<SetupStatus>(["status", "--json"], root)).json
      expect(status.host.name).toBe(host)
      expect(status.features.find(feature => feature.id === id)?.enabled, id).toBe("on")
      if (first.json.status === "applied") {
        expect(first.json.changes, id).toEqual([expect.objectContaining({ after, before, kind: "patch", path: configFile })])
        expect(first.json.changes[0]!.diff, id).toMatch(new RegExp(`^\\+.*\\b${id}: (true|\\{)`, "mu"))
      }
      else {
        expect(after, id).toBe(before)
      }

      const second = await add([id, ...options, "--no-install", "--yes"], root)
      expect(second.exitCode, id).toBe(0)
      expect(second.json).toMatchObject({ changes: [], status: "unchanged" })
      expect(await readFile(join(root, configFile), "utf8"), id).toBe(after)
    }
  }, 30_000)

  it("lists implied features without writing their keys", async () => {
    const root = await copyFixture("node-self-hosted")

    const { exitCode, json } = await add(["agent", "--no-install", "--yes"], root)

    expect(exitCode).toBe(0)
    expect(json.implied).toEqual(["workflow"])
    expect(json.install).toMatchObject({ command: "npm install @vite-hub/agent", packages: ["@vite-hub/agent"] })
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
    expect(config.ok && Object.keys(config.site.keys)).toEqual(["preset", "kv", "agent"])
  })

  it("exits 3 for a feature that the host does not support and writes nothing", async () => {
    const root = await copyFixture("netlify")
    const before = await snapshot(root)

    const { exitCode, json } = await add(["queue", "--yes"], root)

    expect(exitCode).toBe(3)
    expect(json.error).toMatchObject({ code: "SETUP_FEATURE_UNSUPPORTED", message: "queue is not supported on the netlify preset." })
    expect(json.error?.fix).toContain("vitehub catalog")
    expect(await snapshot(root)).toEqual(before)
  })

  it("exits 2 with missing and a rerun that works when the host needs an explicit option", async () => {
    const root = await copyFixture("vercel")

    const first = await add(["email", "--no-install", "--yes"], root)

    expect(first.exitCode).toBe(2)
    expect(first.json.error?.code).toBe("SETUP_INPUT_NEEDED")
    expect(first.json.missing).toEqual([{ choices: ["resend"], field: "email.driver" }])
    expect(first.json.rerun).toBe("vitehub add email --option email.driver=resend --no-install --yes --json")

    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(rerun.json.status).toBe("applied")
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("email: { driver: 'resend' },")

    // The config now sets the option, so the plain command needs no input and changes nothing.
    expect((await add(["email", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("adds kv with the cache driver that Netlify needs", async () => {
    const root = await copyFixture("netlify")

    const { json } = await add(["cache", "--no-install"], root)

    expect(json.missing).toEqual([{ choices: ["kv"], field: "cache.driver" }, { choices: ["upstash"], field: "kv.driver" }])
    expect(json.rerun).toBe("vitehub add cache kv --option cache.driver=kv --option kv.driver=upstash --no-install --yes --json")
    const rerun = await runSetup<AddResult>(json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("kv: { driver: 'upstash' }")
  })

  it("collects the KV prerequisite when the cache driver is supplied", async () => {
    const root = await copyFixture("netlify")
    const before = await snapshot(root)

    const first = await add(["cache", "--option", "cache.driver=kv", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(2)
    expect(first.json.missing).toEqual([{ choices: ["upstash"], field: "kv.driver" }])
    expect(await snapshot(root)).toEqual(before)

    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("kv: { driver: 'upstash' }")
    expect((await add(["cache", "--option", "cache.driver=kv", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it.each([["netlify", "upstash"], ["node", "fs-lite"]])("enables supplied cache prerequisites on %s", async (host, driver) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "${host}" }`) })
    const args = ["cache", "--option", "cache.driver=kv", "--option", `kv.driver=${driver}`, "--no-install", "--yes"]

    const result = await add(args, root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.features).toEqual(["cache", "kv"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain(`kv: { driver: "${driver}" }`)
    expect((await add(args, root)).json.status).toBe("unchanged")
  })

  it("requires a wake configuration for Node Schedules", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node" }`) })
    const before = await snapshot(root)

    const first = await add(["schedule", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(2)
    expect(first.json.missing).toEqual([{ choices: ["process"], field: "schedule.runtime.driver" }])
    expect(await snapshot(root)).toEqual(before)

    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("schedule: { runtime: { driver: \"process\" } }")
    expect((await add(["schedule", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("preserves manual Node Schedule wake ownership", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node", schedule: { providerOutput: false } }`) })
    expect((await add(["schedule", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("repairs a Node Schedule wake configuration that selects provider output", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node", schedule: { runtime: { driver: "process" }, providerOutput: "standalone" } }`) })
    const first = await add(["schedule", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(2)
    expect(first.json.missing).toEqual([{ choices: ["auto"], field: "schedule.providerOutput" }])
    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain('providerOutput: "auto"')
  })

  it.each(["netlify", "deno"])("collects provider inputs for implied Database features on %s", async (host) => {
    for (const feature of ["comments", "connections", "console"]) {
      const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "${host}" }`) })
      const before = await snapshot(root)

      const first = await add([feature, "--no-install", "--yes"], root)
      expect(first.exitCode, feature).toBe(2)
      expect(first.json.missing).toEqual([{ field: "database.connection" }])
      expect(first.json.rerun).toBeUndefined()
      expect(await snapshot(root)).toEqual(before)

      const second = await add([feature, "--option", "database.connection.url=libsql://example.com", "--no-install", "--yes"], root)
      expect(second.exitCode, second.stdout).toBe(0)
      expect(second.json.implied).toContain("database")
      expect(second.json.nextSteps.some(step => step.includes("Set `database.connection`"))).toBe(false)
      expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain('database: { connection: { url: "libsql://example.com" } }')
      expect((await add([feature, "--no-install", "--yes"], root)).json.status).toBe("unchanged")
    }
  })

  it("rejects the Cloudflare Email driver on other hosts before writing", async () => {
    const root = await copyFixture("vercel")
    const before = await snapshot(root)
    const result = await add(["email", "--option", "email.driver=cloudflare-email", "--yes"], root)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_FEATURE_UNSUPPORTED")
    expect(await snapshot(root)).toEqual(before)
  })

  it("builds the feature object from --option", async () => {
    const root = await copyFixture("node-self-hosted")

    const { exitCode, json } = await add(["schedule", "--option", "runtime.driver=process", "--option", "schedule.providerOutput=false", "--no-install", "--yes"], root)

    expect(exitCode).toBe(0)
    expect(json.changes[0]!.diff).toContain("+      schedule: { runtime: { driver: 'process' }, providerOutput: false },")
    expect((await add(["schedule", "--option", "runtime.driver=process", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("writes nothing with --dry-run", async () => {
    const root = await copyFixture("cloudflare")
    const before = await snapshot(root)

    const { exitCode, json, stdout } = await add(["kv", "queue", "--name", "welcome-email", "--dry-run"], root)

    expect(exitCode).toBe(0)
    expect(stdout.trim().split("\n")).toHaveLength(1)
    expect(json).toMatchObject({ features: ["kv", "queue"], host: { name: "cloudflare", source: "config" }, status: "planned" })
    expect(json.changes.map(change => [change.kind, change.path])).toEqual([["create", "server/queues/welcome-email.ts"], ["patch", "vite.config.ts"]])
    expect(await snapshot(root)).toEqual(before)

    const human = await runSetup(["add", "kv", "--dry-run"], root)
    expect(human.stdout).toContain("+++ b/vite.config.ts\n")
    expect(human.stdout).toContain("+      kv: true,\n")
    expect(await snapshot(root)).toEqual(before)
  })

  it("asks for --yes without a terminal and writes nothing", async () => {
    const root = await copyFixture("cloudflare")
    const before = await snapshot(root)

    const { exitCode, json } = await add(["kv"], root)

    expect(exitCode).toBe(2)
    expect(json).toMatchObject({ error: { code: "CLI_R0004" }, rerun: "vitehub add kv --yes --json", status: "planned" })
    expect(json.changes).toHaveLength(1)
    expect(await snapshot(root)).toEqual(before)
  })

  it("creates a starter Definition and never overwrites a file", async () => {
    const root = await copyFixture("cloudflare")

    const first = await add(["queue", "--name", "welcome-email", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(0)
    expect(first.json.changes.map(change => change.path)).toEqual(["server/queues/welcome-email.ts"])
    const starter = await readFile(join(root, "server/queues/welcome-email.ts"), "utf8")
    expect(starter).toContain(`import { defineQueue } from "vite-hub/queue"`)

    expect((await add(["queue", "--name", "welcome-email", "--no-install", "--yes"], root)).json.status).toBe("unchanged")

    await writeFile(join(root, "server/queues/welcome-email.ts"), `${starter}// edited\n`)
    const conflict = await add(["queue", "--name", "welcome-email", "--no-install", "--yes"], root)
    expect(conflict.exitCode).toBe(3)
    expect(conflict.json.error?.code).toBe("SETUP_FILE_EXISTS")
    expect(await readFile(join(root, "server/queues/welcome-email.ts"), "utf8")).toBe(`${starter}// edited\n`)
  })

  it("rejects --name for a feature without Definitions and an unsafe name", async () => {
    const root = await copyFixture("cloudflare")

    expect((await add(["kv", "--name", "cache"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["queue", "--name", "../escape"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["kv", "--option", "nope"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["queue", "--option", "driver=x"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["email", "--option", "database.connection.url=libsql://example.com"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["nope"], root)).json.error?.code).toBe("CLI_R0003")
  })

  it("exits 2 with the feature choices when no feature is named", async () => {
    const root = await copyFixture("cloudflare")

    const { exitCode, json } = await add([], root)

    expect(exitCode).toBe(2)
    expect(json.missing).toEqual([{ choices: [...featureIds], field: "feature" }])
  })

  it("exits 3 with the snippet to paste when the options are not a literal", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": `const options = { preset: "node" as const }\n${viteConfig("options")}`,
    })
    const before = await snapshot(root)

    const { exitCode, json } = await add(["kv", "--option", "driver=fs-lite", "--yes", "--no-install"], root)

    expect(exitCode).toBe(3)
    expect(json.error).toMatchObject({ code: "SETUP_CONFIG_MANUAL" })
    expect(json.error?.why).toContain("(dynamic-options)")
    expect(json.snippet).toBe(`kv: { driver: "fs-lite" },`)
    expect(await snapshot(root)).toEqual(before)
  })

  it("installs the owner packages with the package manager before it writes files", async () => {
    const calls: Array<{ args: string[], command: string, cwd?: string, stdout?: string }> = []
    const spawn: ViteHubCliSpawn = async (command, args, options) => {
      calls.push({ args, command, cwd: options?.cwd, stdout: options?.stdout })
      return { exitCode: 0 }
    }
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node" }`) })

    const { exitCode, json } = await add(["database", "--yes"], root, spawn)

    expect(exitCode).toBe(0)
    expect(json.install).toEqual({ command: "pnpm add @vite-hub/database drizzle-orm && pnpm add -D drizzle-kit", devPackages: ["drizzle-kit"], packages: ["@vite-hub/database", "drizzle-orm"] })
    expect(calls).toEqual([
      { args: ["add", "@vite-hub/database", "drizzle-orm"], command: "pnpm", cwd: root, stdout: "stderr" },
      { args: ["add", "-D", "drizzle-kit"], command: "pnpm", cwd: root, stdout: "stderr" },
    ])
  })

  it("declares owner packages in the target manifest even when hoisted", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "node_modules/@vite-hub/database/package.json": "{}",
      "node_modules/drizzle-orm/package.json": "{}",
      "node_modules/drizzle-kit/package.json": "{}",
      "app/package.json": pnpmManifest,
      "app/vite.config.ts": viteConfig(`{ preset: "node" }`),
    })
    const result = await add(["database", "--dry-run"], join(root, "app"))
    expect(result.exitCode).toBe(0)
    expect(result.json.install.packages).toEqual(["@vite-hub/database", "drizzle-orm"])
    expect(result.json.install.devPackages).toEqual(["drizzle-kit"])
  })

  it("uses target manifest declarations even before dependencies are installed", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/database": "*", "drizzle-orm": "*" }, devDependencies: { "drizzle-kit": "*" } }),
      "vite.config.ts": viteConfig(`{ preset: "node" }`),
    })
    const result = await add(["database", "--dry-run"], root)
    expect(result.exitCode).toBe(0)
    expect(result.json.install).toEqual({ packages: [], devPackages: [] })
  })

  it("reports dependency mutations when a second install fails without writing starter or config files", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node" }`) })
    const config = await readFile(join(root, "vite.config.ts"), "utf8")
    let calls = 0
    const spawn: ViteHubCliSpawn = async () => {
      calls++
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@vite-hub/database": "*", "drizzle-orm": "*" } }))
      await writeFile(join(root, "pnpm-lock.yaml"), `install ${calls}`)
      return { exitCode: calls === 1 ? 0 : 1 }
    }
    const result = await add(["database", "--name", "main", "--yes"], root, spawn)
    expect(calls).toBe(2)
    expect(result.exitCode).toBe(1)
    expect(result.json.error?.code).toBe("SETUP_INSTALL_FAILED")
    expect(result.json.error?.fix).toContain("package manager may have changed")
    expect(await readFile(join(root, "package.json"), "utf8")).not.toBe(pnpmManifest)
    expect(await readFile(join(root, "pnpm-lock.yaml"), "utf8")).toBe("install 2")
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(config)
    expect(Object.keys(await snapshot(root))).not.toContain("server/databases/main/config.ts")
  })

  it("changes no file when the install fails", async () => {
    const spawn: ViteHubCliSpawn = async () => ({ exitCode: 1 })
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node" }`) })
    const before = await snapshot(root)

    const { exitCode, json } = await add(["schedule", "--option", "runtime.driver=process", "--name", "cleanup", "--yes"], root, spawn)

    expect(exitCode).toBe(1)
    expect(json.error).toMatchObject({ code: "SETUP_INSTALL_FAILED", message: "`pnpm add @vite-hub/schedule` exited with code 1." })
    expect(await snapshot(root)).toEqual(before)
  })
})
