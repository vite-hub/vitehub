import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
const workspaceRoot = resolve(packageRoot, "../..")
const childProcessTimeout = 30_000

interface PackedManifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  version: string
}

async function run(command: string, args: string[], cwd: string) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
      },
      killSignal: "SIGKILL",
      timeout: childProcessTimeout,
    })
  }
  catch (error) {
    const output = error as Error & { stderr?: string, stdout?: string }
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
  }
}

async function runPnpm(args: string[], cwd: string) {
  const npmExecPath = process.env.npm_execpath
  return npmExecPath?.includes("pnpm")
    ? await run(process.execPath, [npmExecPath, ...args], cwd)
    : await run("corepack", ["pnpm", ...args], cwd)
}

async function packWorkspacePackage(packDir: string, name: string): Promise<string> {
  const packagePath = join(workspaceRoot, "packages", name)
  const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as PackedManifest
  await runPnpm(["pack", "--pack-destination", packDir], packagePath)
  return join(packDir, `vite-hub-${name}-${manifest.version}.tgz`)
}

function workspaceConfig(packageOverrides: Record<string, string>): string {
  return ["packages:", "  - .", "overrides:", ...Object.entries(packageOverrides).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`), ""].join("\n")
}

async function installConsumer(root: string, dependencies: Record<string, string>, packageOverrides: Record<string, string>): Promise<void> {
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          dependencies,
          packageManager: "pnpm@10.33.0",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(join(root, "pnpm-workspace.yaml"), workspaceConfig(packageOverrides), "utf8"),
  ])
  await runPnpm(["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile", "--strict-peer-dependencies"], root)
}

it("keeps KV optional for packed Schedule consumers", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-optional-kv-"))
  const packDir = join(root, "packs")
  const withoutKV = join(root, "without-kv")
  const withKV = join(root, "with-kv")

  try {
    await Promise.all([mkdir(packDir), mkdir(withoutKV), mkdir(withKV)])
    const [runtimeTarball, scheduleTarball, kvTarball] = await Promise.all([
      packWorkspacePackage(packDir, "runtime"),
      packWorkspacePackage(packDir, "schedule"),
      packWorkspacePackage(packDir, "kv"),
    ])
    const packageOverrides = {
      "@vite-hub/kv": `file:${kvTarball}`,
      "@vite-hub/runtime": `file:${runtimeTarball}`,
      "@vite-hub/schedule": `file:${scheduleTarball}`,
    }
    const { stdout: packedManifestJson } = await run("tar", ["-xOf", scheduleTarball, "package/package.json"], root)
    const packedManifest = JSON.parse(packedManifestJson) as PackedManifest

    expect(packedManifest.dependencies).not.toHaveProperty("@vite-hub/kv")
    expect(packedManifest.peerDependencies?.["@vite-hub/kv"]).toBeTruthy()
    expect(packedManifest.peerDependenciesMeta?.["@vite-hub/kv"]?.optional).toBe(true)

    await installConsumer(
      withoutKV,
      {
        "@vite-hub/schedule": `file:${scheduleTarball}`,
        vite: "8.0.8",
      },
      {
        "@vite-hub/runtime": `file:${runtimeTarball}`,
        "@vite-hub/schedule": `file:${scheduleTarball}`,
      },
    )
    await expect(readFile(join(withoutKV, "node_modules/@vite-hub/kv/package.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await mkdir(join(withoutKV, "src"))
    await Promise.all([
      writeFile(
        join(withoutKV, "src/server.mjs"),
        `
        import { createMemoryRuntimeScheduleStore } from "@vite-hub/schedule"

        const store = createMemoryRuntimeScheduleStore()
        await store.create({
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          cron: "0 * * * *",
          enabled: true,
          id: "built-memory-proof",
          target: "proof",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        })
        if ((await store.get("built-memory-proof"))?.id !== "built-memory-proof") throw new Error("Built memory store failed")
      `,
        "utf8",
      ),
      writeFile(
        join(withoutKV, "vite.config.mjs"),
        `
        import { defineConfig } from "vite"
        import { hubSchedule } from "@vite-hub/schedule/vite"

        export default defineConfig({
          build: {
            outDir: "dist",
            ssr: "src/server.mjs",
          },
          plugins: [hubSchedule({ providerOutput: false })],
        })
      `,
        "utf8",
      ),
    ])
    await run(process.execPath, [join(withoutKV, "node_modules/vite/bin/vite.js"), "build"], withoutKV)
    await run(process.execPath, [join(withoutKV, "dist/server.js")], withoutKV)
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import {
        createKVRuntimeScheduleStore,
        createMemoryRuntimeScheduleStore,
      } from "@vite-hub/schedule"

      const record = {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        cron: "0 * * * *",
        enabled: true,
        id: "memory-proof",
        target: "proof",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }
      const memory = createMemoryRuntimeScheduleStore()
      await memory.create(record)
      if ((await memory.get(record.id))?.id !== record.id) throw new Error("Memory store failed")

      const values = new Map()
      const injected = createKVRuntimeScheduleStore({
        kvStore: {
          del: key => values.delete(key),
          get: key => values.get(key),
          has: key => values.has(key),
          keys: base => [...values.keys()].filter(key => !base || key.startsWith(base)),
          set: (key, value) => values.set(key, value),
        },
      })
      await injected.create({ ...record, id: "injected-proof" })
      if ((await injected.get("injected-proof"))?.id !== "injected-proof") throw new Error("Injected store failed")

      try {
        await createKVRuntimeScheduleStore().get("missing")
        throw new Error("Default KV store unexpectedly loaded")
      }
      catch (error) {
        const expected = "[vitehub:schedule] The default KV-backed stores require @vite-hub/kv. Install it with: pnpm add @vite-hub/kv"
        if (!(error instanceof Error) || error.message !== expected) throw error
      }
    `,
      ],
      withoutKV,
    )

    await installConsumer(
      withKV,
      {
        "@vite-hub/kv": `file:${kvTarball}`,
        "@vite-hub/schedule": `file:${scheduleTarball}`,
      },
      packageOverrides,
    )
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { createKVRuntimeScheduleStore } from "@vite-hub/schedule"

      const store = createKVRuntimeScheduleStore({ prefix: "consumer-proof" })
      const record = {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        cron: "0 * * * *",
        enabled: true,
        id: "default-kv-proof",
        target: "proof",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }
      await store.create(record)
      if ((await store.get(record.id))?.id !== record.id) throw new Error("Default KV store failed")
    `,
      ],
      withKV,
    )
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
