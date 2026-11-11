import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

it("keeps the installed test facade independent of optional Primitives", async () => {
  const consumerRoot = await mkdtemp(resolve(tmpdir(), "vite-hub-test-types-"))
  const installedRoot = resolve(consumerRoot, "node_modules/vite-hub")
  try {
    await mkdir(installedRoot, { recursive: true })
    await copyFile(resolve(packageRoot, "package.json"), resolve(installedRoot, "package.json"))
    await cp(resolve(packageRoot, "dist"), resolve(installedRoot, "dist"), { recursive: true })
    // SAFETY: The checked-in manifest defines the required dependencies; no optional Primitive is installed.
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    for (const name of Object.keys(manifest.dependencies)) {
      const target = resolve(consumerRoot, "node_modules", name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(resolve(packageRoot, "node_modules", name), target, "dir")
    }
    await writeFile(resolve(consumerRoot, "consumer.ts"), `
      import { setupViteHubTest, type DeliverChannelOptions } from "vite-hub/test"
      const hub = setupViteHubTest()
      hub.setEnv({ TEST_VALUE: "local" })
      const options: DeliverChannelOptions = { headers: { "x-secret": "secret" } }
      const subject: string | undefined = hub.emails[0]?.subject
      void [options, subject, hub.jobs, hub.workflows]
      await hub.reset()
    `)
    await writeFile(resolve(consumerRoot, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(resolve(consumerRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, strict: true, skipLibCheck: false, types: [] },
      files: ["consumer.ts"],
    }))
    const result = await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", consumerRoot]).catch((error: unknown) => {
      if (error instanceof Error && "stdout" in error) return { stdout: String(error.stdout) }
      throw error
    })
    expect(result.stdout).toBe("")
    await execFileAsync(process.execPath, ["--input-type=module", "-e", `
      import { setupViteHubTest } from "vite-hub/test"
      const hub = setupViteHubTest()
      hub.setEnv({ TEST_VALUE: "local" })
      await hub.reset()
    `], { cwd: consumerRoot })
  }
  finally {
    await rm(consumerRoot, { recursive: true, force: true })
  }
}, 60_000)

it("keeps installed Console sections independent of optional Auth packages", async () => {
  const consumerRoot = await mkdtemp(resolve(tmpdir(), "vite-hub-console-types-"))
  const installedRoot = resolve(consumerRoot, "node_modules/vite-hub")
  try {
    await mkdir(installedRoot, { recursive: true })
    await copyFile(resolve(packageRoot, "package.json"), resolve(installedRoot, "package.json"))
    await cp(resolve(packageRoot, "dist"), resolve(installedRoot, "dist"), { recursive: true })
    // SAFETY: The checked-in package manifest defines these dependency maps.
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (name === "@vite-hub/auth" || name === "better-auth") continue
      const target = resolve(consumerRoot, "node_modules", name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(resolve(packageRoot, "node_modules", name), target, "dir")
    }
    await writeFile(resolve(consumerRoot, "consumer.ts"), `
      import { consoleRealtimeAccess, installConsoleSections } from "./node_modules/vite-hub/dist/console/runtime/server/sections.js"
      import { defineConsoleAuthorize } from "./node_modules/vite-hub/dist/console/auth.js"
      installConsoleSections("/consumer", [])
      consoleRealtimeAccess("content")
      defineConsoleAuthorize(({ user }) => Boolean(user))
    `)
    await writeFile(resolve(consumerRoot, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(resolve(consumerRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, strict: true, skipLibCheck: false, types: [] },
      files: ["consumer.ts"],
    }))
    const result = await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", consumerRoot]).catch((error: unknown) => {
      if (error instanceof Error && "stdout" in error) return { stdout: String(error.stdout) }
      throw error
    })
    // Check the consumer and framework declarations, excluding unrelated third-party diagnostics.
    const ownDiagnostics = result.stdout.split("\n").filter(line => line.includes("error TS") && (
      line.includes("consumer.ts(") || line.includes(`${consumerRoot.split("/").at(-1)}/node_modules/vite-hub/`)
    ))
    expect(ownDiagnostics).toEqual([])
  }
  finally {
    await rm(consumerRoot, { recursive: true, force: true })
  }
}, 60_000)

it("publishes Env's Vite config augmentation from the framework root", async () => {
  await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", resolve(packageRoot, "fixtures/published-types")])
}, 10_000)

it("keeps the installed Database runtime facade declaration self-contained", async () => {
  const consumerRoot = await mkdtemp(resolve(tmpdir(), "vite-hub-database-types-"))
  const installedRoot = resolve(consumerRoot, "node_modules/vite-hub")
  // Nuxt aliases `@vite-hub/database/runtime/state` to this file. It is not a package export.
  const installedState = resolve(installedRoot, "dist/internal/database-runtime-state")

  try {
    await mkdir(dirname(installedState), { recursive: true })
    await copyFile(resolve(packageRoot, "package.json"), resolve(installedRoot, "package.json"))
    await copyFile(resolve(packageRoot, "dist/internal/database-runtime-state.js"), `${installedState}.js`)
    await copyFile(resolve(packageRoot, "dist/internal/database-runtime-state.d.ts"), `${installedState}.d.ts`)
    await writeFile(resolve(consumerRoot, "consumer.ts"), `
      import { setActiveCloudflareEnv } from "./node_modules/vite-hub/dist/internal/database-runtime-state.js"
      setActiveCloudflareEnv({ DB: {} })
    `)
    await writeFile(resolve(consumerRoot, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(resolve(consumerRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        types: [],
      },
      files: ["consumer.ts"],
    }))

    await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", consumerRoot])
  }
  finally {
    await rm(consumerRoot, { recursive: true, force: true })
  }
}, 10_000)

it.each(["evlog", "ai"])("keeps installed framework declarations independent of optional %s", async (optionalPeer) => {
  const consumerRoot = await mkdtemp(resolve(tmpdir(), "vite-hub-root-types-"))
  const installedRoot = resolve(consumerRoot, "node_modules/vite-hub")
  try {
    await mkdir(installedRoot, { recursive: true })
    await copyFile(resolve(packageRoot, "package.json"), resolve(installedRoot, "package.json"))
    await cp(resolve(packageRoot, "dist"), resolve(installedRoot, "dist"), { recursive: true })
    // SAFETY: The checked-in package manifest defines these dependency maps.
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (name === optionalPeer) continue
      const target = resolve(consumerRoot, "node_modules", name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(resolve(packageRoot, "node_modules", name), target, "dir")
    }
    await writeFile(resolve(consumerRoot, "consumer.ts"), `
      import { vitehub, type ObservabilityEvlogOptions } from "vite-hub"
      import { getLogSource, installLogSource } from "vite-hub/logs/host"
      import { parseLogQuery, type LogSource } from "vite-hub/logs/source"
      const source: LogSource | undefined = getLogSource()
      if (source) installLogSource("/consumer", source)
      parseLogQuery({ level: "error" })
      vitehub({ preset: "cloudflare", observability: { service: "consumer", evlog: { pretty: true, sampling: { rates: { info: 25 } } } } })
      vitehub({ preset: "node", agent: { providers: { state: { driver: "memory" } }, invocations: { retention: { maxRecords: 10 } } } })
      // @ts-expect-error Agent backends use driver.
      vitehub({ agent: { providers: { state: { provider: "memory" } } } })
      const valid: ObservabilityEvlogOptions = { dev: { prettyError: { detail: "full" } }, redact: { builtins: ["email"], patterns: [/secret/], replacement: (matched: unknown, context: { path: string, key: string, groups?: Array<string | undefined> }) => context.path }, sampling: { keep: [{ status: 400 }] } }
      void valid
      // @ts-expect-error Unsupported terminal preset.
      const invalidDev: ObservabilityEvlogOptions = { dev: "bogus" }
      // @ts-expect-error Redaction accepts a Boolean or a configuration object.
      const invalidRedact: ObservabilityEvlogOptions = { redact: 123 }
      // @ts-expect-error Sampling rates must be numbers.
      const invalidSampling: ObservabilityEvlogOptions = { sampling: { rates: { info: "all" } } }
      // @ts-expect-error Unknown Nitro options must not be forwarded without validation.
      const invalidUnknown: ObservabilityEvlogOptions = { unsupported: true }
      void [invalidDev, invalidRedact, invalidSampling, invalidUnknown]

    `)
    await writeFile(resolve(consumerRoot, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await execFileAsync(process.execPath, ["--input-type=module", "-e", `
      import { createLogBuffer } from "vite-hub/logs/memory"
      import { getLogSource, installLogSource } from "vite-hub/logs/host"
      import { parseLogQuery } from "vite-hub/logs/source"
      import { strict as assert } from "node:assert"
      const buffer = createLogBuffer()
      installLogSource("/consumer", buffer.source)
      assert.equal(getLogSource(), buffer.source)
      assert.deepEqual((await buffer.source.query(parseLogQuery({}))).entries, [])
    `], { cwd: consumerRoot })
    await writeFile(resolve(consumerRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["consumer.ts"],
    }))
    const result = await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", consumerRoot]).catch((error: unknown) => {
      if (error instanceof Error && "stdout" in error) return { stdout: String(error.stdout) }
      throw error
    })
    // Installed third-party packages have unrelated strict declaration errors. Check
    // the isolated consumer and all copied ViteHub declarations with library checks enabled.
    const ownDiagnostics = result.stdout.split("\n").filter(line => line.includes("error TS") && (
      line.includes("consumer.ts(") || line.includes(`${consumerRoot.split("/").at(-1)}/node_modules/vite-hub/`)
    ))
    expect(ownDiagnostics).toEqual([])
  }
  finally {
    await rm(consumerRoot, { recursive: true, force: true })
  }
}, 60_000)
