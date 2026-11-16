import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { createSetupSession, setupRequestArgs } from "../src/setup/index.ts"
import { createProject, fakePackageManager, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupCommandRunner } from "../src/setup/index.ts"

/** A runner that records each call and edits nothing, so a test never runs a real package manager. */
function fakeRunner(): { calls: { command: string, args: readonly string[], cwd: string }[], run: SetupCommandRunner } {
  const calls: { command: string, args: readonly string[], cwd: string }[] = []
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ args, command, cwd: options.cwd })
      options.onOutput(`installed ${args.slice(1).join(" ")}\n`, "stdout")
      return { exitCode: 0 }
    },
  }
}

async function project(): Promise<string> {
  return await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ host: \"node\" }") })
}

describe("createSetupSession", () => {
  it.each(["vite", "nuxt"])("finishes removal before writing the %s config that restarts the server", async (framework) => {
    const configFile = `${framework}.config.ts`
    const root = await createProject({
      "package.json": pnpmManifest,
      [configFile]: framework === "vite" ? viteConfig('{ host: "node" }') : 'export default defineNuxtConfig({ modules: [["vite-hub/nuxt", { host: "node" }]] })\n',
    })
    const added = await runSetup(["add", "schedule", "--name", "nightly", "--option", "schedule.runtime.driver=process", "--yes", "--json"], root, {}, { spawn: fakePackageManager(root).spawn })
    expect(added.exitCode, added.stdout).toBe(0)
    const before = await readFile(join(root, configFile), "utf8")
    let uninstalled = false
    const session = createSetupSession({ env: {}, root, run: async () => {
      expect(await readFile(join(root, configFile), "utf8")).toBe(before)
      expect(existsSync(join(root, "server/schedules/nightly.ts"))).toBe(false)
      uninstalled = true
      return { exitCode: 0 }
    } })
    const planned = await session.plan({ action: "remove", features: ["schedule"] })
    expect(planned.exitCode, JSON.stringify(planned.body)).toBe(0)
    const applied = await session.apply(planned.body.planId)
    expect(applied.exitCode, JSON.stringify(applied.body)).toBe(0)
    expect(uninstalled).toBe(true)
    expect(await readFile(join(root, configFile), "utf8")).not.toBe(before)
  })

  it.each(["vite", "nuxt"])("preserves a %s config saved during uninstall", async (framework) => {
    const configFile = `${framework}.config.ts`
    const before = framework === "vite"
      ? viteConfig('{ host: "node", realtime: true }')
      : 'export default defineNuxtConfig({ modules: [["vite-hub/nuxt", { host: "node", realtime: true }]] })\n'
    const edited = `${before}\n// Saved while uninstall runs.\n`
    const root = await createProject({
      "package.json": JSON.stringify({ name: "app", packageManager: "pnpm@10.0.0", dependencies: { "@vite-hub/realtime": "1.0.0" } }),
      [configFile]: before,
    })
    const session = createSetupSession({ env: {}, root, run: async () => {
      await writeFile(join(root, configFile), edited)
      return { exitCode: 0 }
    } })
    const planned = await session.plan({ action: "remove", features: ["realtime"] })
    expect(planned.exitCode, JSON.stringify(planned.body)).toBe(0)

    const applied = await session.apply(planned.body.planId)

    expect(applied.exitCode).toBe(4)
    expect(applied.body.error).toMatchObject({ code: "SETUP_STALE_PLAN" })
    expect(await readFile(join(root, configFile), "utf8")).toBe(edited)
    expect((await session.apply(planned.body.planId)).body.error).toMatchObject({ code: "SETUP_PLAN_UNKNOWN" })
  })

  it("keeps the restart-triggering config when uninstall fails", async () => {
    const before = viteConfig('{ host: "node", realtime: true }')
    const root = await createProject({
      "package.json": JSON.stringify({ name: "app", packageManager: "pnpm@10.0.0", dependencies: { "@vite-hub/realtime": "1.0.0" } }),
      "vite.config.ts": before,
    })
    const session = createSetupSession({ env: {}, root, run: async () => ({ exitCode: 1 }) })
    const planned = await session.plan({ action: "remove", features: ["realtime"] })
    expect(planned.exitCode).toBe(0)
    const applied = await session.apply(planned.body.planId)
    expect(applied.exitCode).toBe(1)
    expect(applied.body.error).toMatchObject({ code: "SETUP_UNINSTALL_FAILED" })
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(before)
  })

  it("plans the same document as `vitehub add --dry-run --json`, with a plan id and the CLI command", async () => {
    const root = await project()
    const session = createSetupSession({ env: {}, root, run: fakeRunner().run })
    const planned = await session.plan({ action: "add", features: ["kv"] })
    const cli = await runSetup<Record<string, unknown>>(["add", "kv", "--dry-run", "--json"], root)

    expect(planned.exitCode).toBe(0)
    const { command, planId, restart, ...document } = planned.body
    expect(document).toEqual(cli.json)
    expect(planId).toEqual(expect.any(String))
    expect(command).toBe("vitehub add kv --yes")
    expect(restart).toBe(true)
  })

  it("applies a plan once and writes the config", async () => {
    const root = await project()
    const runner = fakeRunner()
    const session = createSetupSession({ env: {}, root, run: runner.run })
    const planned = await session.plan({ action: "add", features: ["kv"] })
    const applied = await session.apply(planned.body.planId)

    expect(applied.exitCode).toBe(0)
    expect(applied.body).toMatchObject({ command: "vitehub add kv --yes", restart: true, status: "applied" })
    expect(applied.body.planId).toBeUndefined()
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("kv: true")

    const replayed = await session.apply(planned.body.planId)
    expect(replayed.exitCode).toBe(1)
    expect(replayed.body.error).toMatchObject({ code: "SETUP_PLAN_UNKNOWN" })
  })

  it("rejects a plan whose config changed, and does not keep it", async () => {
    const root = await project()
    const session = createSetupSession({ env: {}, root, run: fakeRunner().run })
    const planned = await session.plan({ action: "add", features: ["kv"] })
    const edited = viteConfig("{ host: \"node\", queue: true }")
    await writeFile(join(root, "vite.config.ts"), edited)

    const stale = await session.apply(planned.body.planId)
    expect(stale.exitCode).toBe(4)
    expect(stale.body.error).toMatchObject({ code: "SETUP_STALE_PLAN", why: "vite.config.ts changed after ViteHub planned the change." })
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(edited)
    expect((await session.apply(planned.body.planId)).body.error).toMatchObject({ code: "SETUP_PLAN_UNKNOWN" })
  })

  it("rejects a plan when a file that was absent appears", async () => {
    const root = await project()
    const session = createSetupSession({ env: {}, root, run: fakeRunner().run })
    const planned = await session.plan({ action: "add", features: ["queue"], name: "emails" })
    const starter = (planned.body.changes as { kind: string, path: string }[]).find(change => change.kind === "create")!
    await mkdir(dirname(join(root, starter.path)), { recursive: true })
    await writeFile(join(root, starter.path), "export default {}\n")

    const stale = await session.apply(planned.body.planId)
    expect(stale.exitCode).toBe(4)
    expect(stale.body.error).toMatchObject({ code: "SETUP_STALE_PLAN" })
  })

  it("runs the package manager with an argument array in the project root and streams its output", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ host: \"node\" }") })
    const runner = fakeRunner()
    const output: string[] = []
    const session = createSetupSession({ env: {}, root, run: runner.run })
    const planned = await session.plan({ action: "add", features: ["workspace"] })
    expect(planned.body.install).toMatchObject({ packages: ["@vite-hub/workspace"] })

    const applied = await session.apply(planned.body.planId, text => output.push(text))
    expect(applied.exitCode).toBe(0)
    expect(runner.calls).toEqual([{ args: ["add", "@vite-hub/workspace"], command: "pnpm", cwd: root }])
    expect(output).toEqual(["installed @vite-hub/workspace\n"])
  })

  it("plans and applies remove", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ host: \"node\", kv: true }") })
    const session = createSetupSession({ env: {}, root, run: fakeRunner().run })
    const planned = await session.plan({ action: "remove", features: ["kv"] })
    const cli = await runSetup<Record<string, unknown>>(["remove", "kv", "--dry-run", "--json"], root)
    const { command, planId: _planId, restart: _restart, ...document } = planned.body
    expect(document).toEqual(cli.json)
    expect(command).toBe("vitehub remove kv --yes")

    expect((await session.apply(planned.body.planId)).body).toMatchObject({ status: "applied" })
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).not.toContain("kv")
  })

  it("answers the input that a feature needs, as the CLI does", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ host: \"vercel\" }") })
    const session = createSetupSession({ env: {}, root, run: fakeRunner().run })
    const result = await session.plan({ action: "add", features: ["email"] })
    expect(result.exitCode).toBe(2)
    expect(result.body).toMatchObject({ error: { code: "SETUP_INPUT_NEEDED" }, missing: [{ choices: ["resend"], field: "email.driver" }] })

    const planned = await session.plan({ action: "add", features: ["email"], options: ["email.driver=resend"] })
    expect(planned.body).toMatchObject({ command: "vitehub add email --option=email.driver=resend --yes", status: "planned" })
  })

  it("reads the catalog and the status documents", async () => {
    const root = await project()
    const session = createSetupSession({ env: {}, root, run: fakeRunner().run })
    const catalog = session.catalog()
    expect(catalog.body.features).toEqual(expect.arrayContaining([expect.objectContaining({ id: "kv", title: "KV" })]))
    const status = await session.status()
    expect(status.body).toMatchObject({ framework: "vite", host: { name: "node" }, root })
  })
})

describe("setupRequestArgs", () => {
  it("turns a request into inline CLI arguments", () => {
    expect(setupRequestArgs({ action: "add", features: ["kv", "queue"], install: false, name: "emails", options: ["kv.driver=upstash"] }))
      .toEqual({ action: "add", argv: ["kv", "queue", "--name=emails", "--option=kv.driver=upstash", "--no-install"] })
    expect(setupRequestArgs({ action: "remove", features: ["kv"], force: true, keepFiles: true, uninstall: false }))
      .toEqual({ action: "remove", argv: ["kv", "--force", "--keep-files", "--no-uninstall"] })
  })

  it.each([
    [{ action: "add", features: ["kv"], root: "/etc" }, "Unknown field `root` for add."],
    [{ action: "add", features: ["kv"], path: "../x" }, "Unknown field `path` for add."],
    [{ action: "add", features: ["kv"], command: "rm" }, "Unknown field `command` for add."],
    [{ action: "remove", features: ["kv"], name: "x" }, "Unknown field `name` for remove."],
    [{ action: "add", features: ["--dry-run"] }, "Unknown feature \"--dry-run\"."],
    [{ action: "add", features: ["../kv"] }, "Unknown feature \"../kv\"."],
    [{ action: "run", features: ["kv"] }, "`action` must be \"add\" or \"remove\"."],
    [{ action: "add", features: [] }, "Name at least one feature."],
    [{ action: "add", features: ["kv"], install: "no" }, "`install` must be true or false."],
  ])("rejects %j", (request, message) => {
    expect(() => setupRequestArgs(request)).toThrow(message)
  })

  it("never takes a path from the name of a starter Definition", async () => {
    const root = await project()
    const session = createSetupSession({ env: {}, root, run: fakeRunner().run })
    const result = await session.plan({ action: "add", features: ["queue"], name: "../../etc/passwd" })
    expect(result.exitCode).toBe(1)
    expect(result.body.error).toMatchObject({ code: "CLI_R0003" })
  })
})
