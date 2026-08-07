import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

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
