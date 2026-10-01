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

it("publishes Env's Vite config augmentation from the framework root", async () => {
  await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", resolve(packageRoot, "fixtures/published-types")])
}, 10_000)

it("keeps the installed Database runtime facade declaration self-contained", async () => {
  const consumerRoot = await mkdtemp(resolve(tmpdir(), "vite-hub-database-types-"))
  const installedRoot = resolve(consumerRoot, "node_modules/vite-hub")
  const installedState = resolve(installedRoot, "dist/_internal/database/runtime/state")

  try {
    await mkdir(dirname(installedState), { recursive: true })
    await copyFile(resolve(packageRoot, "package.json"), resolve(installedRoot, "package.json"))
    await copyFile(resolve(packageRoot, "dist/_internal/database/runtime/state.js"), `${installedState}.js`)
    await copyFile(resolve(packageRoot, "dist/_internal/database/runtime/state.d.ts"), `${installedState}.d.ts`)
    await writeFile(resolve(consumerRoot, "consumer.ts"), `
      import { setActiveCloudflareEnv } from "vite-hub/_internal/database/runtime/state"
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

it("keeps installed framework declarations independent of optional evlog", async () => {
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
      if (name === "evlog") continue
      const target = resolve(consumerRoot, "node_modules", name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(resolve(packageRoot, "node_modules", name), target, "dir")
    }
    await writeFile(resolve(consumerRoot, "consumer.ts"), `
      import { vitehub, type ObservabilityEvlogOptions } from "vite-hub"
      vitehub({ preset: "cloudflare", observability: { service: "consumer", evlog: { pretty: true, sampling: { rates: { info: 25 } } } } })
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
