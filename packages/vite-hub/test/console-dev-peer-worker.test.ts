import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { build } from "esbuild"
import { expect, it } from "vitest"

it("does not pass the dev peer key to a child after a signed Console call", async () => {
  const root = resolve(import.meta.dirname, "..")
  const result = await build({
    alias: { "#vitehub/console/app": join(import.meta.dirname, "fixtures/console-app.ts") },
    bundle: true,
    define: { "import.meta.viteHubConsoleDevelopment": "true" },
    external: ["#vitehub/*"],
    format: "esm",
    logOverride: { "ignored-bare-import": "silent" },
    packages: "external",
    platform: "node",
    write: false,
    stdin: { resolveDir: root, contents: `
      import assert from "node:assert/strict"
      import { execFile } from "node:child_process"
      import { fileURLToPath } from "node:url"
      import { promisify } from "node:util"
      import { installConsoleAccess } from "./src/console/runtime/server/access.ts"
      import { installConsoleDevelopment } from "./src/console/runtime/server/development.ts"
      import { installConsoleSections } from "./src/console/runtime/server/sections.ts"
      import { handleConsoleRpcRequest } from "./test/support/console-rpc.ts"
      import { consoleTestKey, signedRpcRequest } from "./test/support/console-signature.ts"

      installConsoleDevelopment(process.cwd(), true)
      installConsoleSections(process.cwd(), [])
      installConsoleAccess({ mode: "token" })
      const { env, key } = await consoleTestKey("DEV")
      Object.assign(process.env, env)
      const rpc = await handleConsoleRpcRequest(await signedRpcRequest({ key }))
      assert.equal(rpc.status, 200, await rpc.text())
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./child.mjs", import.meta.url))])
    ` },
  })
  const directory = await mkdtemp(join(import.meta.dirname, ".console-dev-peer-worker-"))
  try {
    const entry = join(directory, "worker.mjs")
    const observed = join(directory, "inherited.txt")
    await writeFile(entry, result.outputFiles[0]!.text)
    await writeFile(join(directory, "child.mjs"), `import { writeFile } from "node:fs/promises"\nawait writeFile(${JSON.stringify(observed)}, String("VITEHUB_DEV_PEER_KEY" in process.env))\n`)
    await promisify(execFile)(process.execPath, [entry], {
      env: { ...process.env, VITEHUB_DEV_PEER_KEY: "fixture-peer-key-for-isolated-worker" },
      timeout: 10_000,
    })
    await expect(readFile(observed, "utf8")).resolves.toBe("false")
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
