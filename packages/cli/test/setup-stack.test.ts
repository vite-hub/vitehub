import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { describe, expect, it } from "vitest"

import { createProject, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupError, SetupInitPlan, SetupStatus } from "../src/setup/index.ts"

type StatusResult = SetupStatus & { stack: SetupInitPlan["stack"] | null }

function status(root: string) {
  return runSetup<StatusResult>(["status", "--offline", "--json"], root)
}

function replay(command: string, parent: string) {
  const args = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`], { encoding: "utf8" }).split("\0").slice(3, -1)
  return runSetup<SetupInitPlan & { error?: SetupError }>([...args, "--no-install", "--json"], parent)
}

function featureStates(result: StatusResult) {
  return Object.fromEntries(result.features.map(feature => [feature.id, feature.enabled]))
}

describe("setup stack replay", () => {
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
