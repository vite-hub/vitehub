import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { describe, expect, it } from "vitest"

import { createProject, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupError, SetupInitPlan, SetupStatus } from "../src/setup/index.ts"

type StatusResult = SetupStatus & { stack: SetupInitPlan["stack"] | null }
type InitResult = SetupInitPlan & { error?: SetupError, rerun?: string }

const installedKV = {
  "node_modules/@vite-hub/kv/package.json": "{}",
  "node_modules/@upstash/redis/package.json": "{}",
}

function status(root: string) {
  return runSetup<StatusResult>(["status", "--offline", "--json"], root)
}

function replay(command: string | null, parent: string) {
  if (command === null) throw new Error("Expected a replay command")
  const args = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`], { encoding: "utf8" }).split("\0").slice(3, -1)
  return runSetup<InitResult>([...args, "--no-install", "--json"], parent)
}

function featureStates(result: StatusResult) {
  return Object.fromEntries(result.features.map(feature => [feature.id, feature.enabled]))
}

describe("setup stack replay", () => {
  it.each([
    ["kv.token", "dummy-upstash-token", "upstash"],
    ["kv.url", "redis://dummy-user:dummy-password@localhost:6379", "redis"],
  ])("omits the credential in %s from init and status stacks", async (field, value, driver) => {
    const parent = await createProject()
    const root = join(parent, "app")
    const args = ["init", "app", "--host", "node", "--features", "kv", "--option", `kv.driver=${driver}`, "--option", `${field}=${value}`, "--no-install", "--yes"]
    const planned = await runSetup<SetupInitPlan>([...args, "--dry-run", "--json"], parent)
    const dryRun = await runSetup([...args, "--dry-run"], parent)
    const applied = await runSetup(args, parent)
    const unchanged = await runSetup<SetupInitPlan>([...args, "--json"], parent)
    const current = await status(root)
    const text = await runSetup(["status", "--offline"], root)

    for (const result of [planned, dryRun, applied, unchanged, current, text]) expect(result.exitCode, result.stdout).toBe(0)
    for (const stack of [planned.json.stack, unchanged.json.stack, current.json.stack]) {
      expect(JSON.stringify(stack)).not.toContain(value)
      expect(stack?.omits).toContainEqual({ path: field, reason: "credential-option" })
      expect(stack?.command).toContain(`kv.driver=${driver}`)
    }
    for (const result of [dryRun, applied, text]) {
      expect(result.stdout).not.toContain(value)
      expect(result.stdout).toContain(`${field} (credential-option)`)
    }
  })

  it.each([
    ["netlify", "kv: true", "kv.driver"],
    ["netlify", "kv: { stores: { sessions: { driver: 'upstash' } } }", "kv.stores.default.driver"],
    ["netlify", "kv: { stores: { default: { driver: 'unknown' }, sessions: { driver: 'upstash' } } }", "kv.stores.default.driver"],
    ["vercel", "comments: true, database: { connection: selectConnection() }", "database.connection"],
  ])("does not offer a command that init cannot plan on %s with %s", async (host, config, field) => {
    const root = await createProject({ "vite.config.ts": viteConfig(`{ host: '${host}', ${config} }`) })
    const source = await runSetup<StatusResult>(["status", "--offline", "--json"], root, { UPSTASH_REDIS_REST_URL: "https://redis.example.test", UPSTASH_REDIS_REST_TOKEN: "dummy" })
    expect(source.exitCode, source.stdout).toBe(0)
    expect(source.json.stack?.command).toBeNull()
    expect(source.json.stack?.omits).toContainEqual({ path: field, reason: "required-option" })
  })

  it.each([
    ["kv.driver", "{ driver: 'upstash' }", { driver: "upstash" }],
    ["kv.stores.default.driver", "{ stores: { default: { driver: 'upstash' } } }", { stores: { default: { driver: "upstash" } } }],
  ])("replays a Netlify KV provider set at %s", async (path, config, value) => {
    const root = await createProject({ ...installedKV, "app/vite.config.ts": viteConfig(`{ host: 'netlify', kv: ${config} }`) })
    const source = await status(join(root, "app"))
    expect(source.exitCode, source.stdout).toBe(0)
    expect(source.json.stack).toMatchObject({ command: expect.stringContaining(`--option ${path}=upstash`), omits: [] })
    const destination = await createProject()
    const result = await replay(source.json.stack!.command, destination)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages).toContain("@upstash/redis")
    expect(source.json.features.find(feature => feature.id === "kv")?.fix).toBeUndefined()
    const copied = join(destination, "app")
    expect(locateViteHubConfig("vite.config.ts", await readFile(join(copied, "vite.config.ts"), "utf8"))).toMatchObject({
      ok: true,
      site: { keys: { kv: { value } } },
    })
    expect(result.json.stack).toEqual(source.json.stack)
    expect((await status(copied)).json.stack).toEqual(source.json.stack)
  })

  it("retries a named-only Netlify KV config with a nested default", async () => {
    const root = await createProject({ ...installedKV, "app/vite.config.ts": viteConfig("{ host: 'netlify', kv: { stores: { sessions: { driver: 'upstash' } } } }") })
    expect((await status(join(root, "app"))).json.features.find(feature => feature.id === "kv")?.fix).toContain("`kv.stores.default.driver`")

    const destination = await createProject()
    const first = await runSetup<InitResult>(["init", "app", "--host", "netlify", "--features", "kv", "--option", "kv.stores.sessions.driver=upstash", "--no-install", "--yes", "--json"], destination)
    expect(first.exitCode).toBe(2)
    expect(first.json.rerun).toContain("--option kv.stores.default.driver=upstash")
    const result = await replay(first.json.rerun ?? null, destination)
    expect(result.exitCode, result.stdout).toBe(0)
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(destination, "app/vite.config.ts"), "utf8"))
    const kv = config.ok && config.site.keys.kv
    expect(kv && kv.kind === "literal" && kv.value).toEqual({ stores: { sessions: { driver: "upstash" }, default: { driver: "upstash" } } })
  })

  it("replays the current features and options after add and remove", async () => {
    const parent = await createProject({ "pnpm-workspace.yaml": "packages: []\n" })
    const app = "-team's app"
    const root = join(parent, app)
    const created = await runSetup<SetupInitPlan>(["init", `./${app}`, "--host", "cloudflare", "--features", "kv", "--yes", "--no-install", "--json"], parent)
    expect(created.exitCode, created.stdout).toBe(0)
    expect(created.json.stack).toEqual((await status(root)).json.stack)

    for (const args of [
      ["add", "blob", "--option", "blob.store.bucketName=uploads-east", "--no-install"],
      ["add", "queue", "--name", "emails", "--no-install"],
      ["remove", "kv", "--no-uninstall"],
    ]) {
      const result = await runSetup([...args, "--yes", "--json"], root)
      expect(result.exitCode, result.stdout).toBe(0)
    }
    expect(existsSync(join(root, "server/queues/emails.ts"))).toBe(true)

    const source = (await status(root)).json
    expect(featureStates(source)).toMatchObject({ blob: "on", env: "on", kv: "off", queue: "on" })
    expect(source.stack).toMatchObject({ command: expect.stringContaining("--features blob,queue"), omits: [] })
    const destination = await createProject({ "pnpm-workspace.yaml": "packages: []\n" })
    const recreated = await replay(source.stack!.command, destination)
    expect(recreated.exitCode, recreated.stdout).toBe(0)
    const copy = join(destination, app)
    const copied = (await status(copy)).json
    expect(featureStates(copied)).toEqual(featureStates(source))
    expect(copied.host).toEqual(source.host)
    expect(copied.packageManager).toBe("pnpm")
    expect(copied.stack).toEqual(source.stack)
    expect(locateViteHubConfig("vite.config.ts", await readFile(join(copy, "vite.config.ts"), "utf8"))).toMatchObject({
      ok: true,
      site: { keys: { blob: { value: { store: { bucketName: "uploads-east" } } }, queue: { value: true } } },
    })
    expect(existsSync(join(copy, "server/queues/emails.ts"))).toBe(false)
  })

  it("replays static manual edits and reports the omitted settings", async () => {
    const parent = await createProject({ "app/package.json": "{}" })
    const root = join(parent, "app")
    await writeFile(join(root, "vite.config.ts"), viteConfig(`{
      ...sharedOptions,
      host: "cloudflare",
      env: false,
      kv: false,
      email: chooseEmail(),
      blob: { store: { binding: "TEAM_BLOB", bucketName: "true" } },
      queue: true,
    }`))

    const source = await status(root)
    expect(source.exitCode, source.stdout).toBe(0)
    expect(source.loadConfig).not.toHaveBeenCalled()
    expect(source.json.stack?.omits).toEqual([
      { path: "config", reason: "spread" },
      { path: "blob.store.bucketName", reason: "non-replayable-option" },
      { path: "email", reason: "expression" },
      { path: "env", reason: "disabled-feature" },
    ])
    expect((await runSetup(["status", "--offline"], root)).stdout).toContain("env (disabled-feature)")
    const destination = await createProject()
    const recreated = await replay(source.json.stack!.command, destination)
    expect(recreated.exitCode, recreated.stdout).toBe(0)
    const copy = join(destination, "app")
    expect(featureStates((await status(copy)).json)).toMatchObject({ blob: "on", email: "off", env: "on", kv: "off", queue: "on" })
    expect(locateViteHubConfig("vite.config.ts", await readFile(join(copy, "vite.config.ts"), "utf8"))).toMatchObject({
      site: { keys: { blob: { value: { store: { binding: "TEAM_BLOB" } } } } },
    })
  })

  it("passes the unresolved host placeholder as a literal shell argument", async () => {
    const parent = await createProject({ "app/vite.config.ts": viteConfig('{ host: pickHost(), kv: true }') })
    const source = await status(join(parent, "app"))
    expect(source.json.stack?.command).toContain("--host '<host>'")
    expect(source.json.stack?.omits).toEqual([{ path: "host", reason: "unresolved-host" }])
    const destination = await createProject()
    const result = await replay(source.json.stack!.command, destination)
    expect(result.exitCode).toBe(1)
    expect(result.json.error).toMatchObject({ code: "CLI_R0003", message: expect.stringContaining('not "<host>"') })
    expect(existsSync(join(destination, "app"))).toBe(false)
  })
})
