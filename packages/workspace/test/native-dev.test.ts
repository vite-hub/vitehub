import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

import { hubWorkspace } from "../src/vite.ts"

const execFileAsync = promisify(execFile)

it("installs the native Workspace registry before an existing plugin reads it at module evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-native-order-"))
  try {
    const consumer = join(root, "consumer.mjs")
    await mkdir(join(root, "server/workspaces/mirror"), { recursive: true })
    await writeFile(join(root, "server/workspaces/mirror/config.ts"), 'export default { store: { provider: "memory" } }\n')
    const plugin = hubWorkspace()
    const hook = typeof plugin.config === "function" ? plugin.config : plugin.config!.handler
    const config = { root, nitro: { plugins: [consumer] } }
    await hook.call({} as never, config as never, { command: "serve", mode: "development" })
    const plugins = config.nitro.plugins
    const installer = join(root, ".vitehub/nitro/workspace/plugin.ts")
    const source = (await readFile(installer, "utf8")).replace(/(['"])(@vite-hub\/workspace[^'"]*)\1/g, (_match, _quote, specifier: string) => JSON.stringify(import.meta.resolve(specifier)))
    await writeFile(installer, source)
    await writeFile(consumer, [
      `import { useWorkspace } from ${JSON.stringify(import.meta.resolve("@vite-hub/workspace"))}`,
      `const workspace = useWorkspace("mirror", { mode: "write" })`,
      `await workspace.capabilities()`,
      `process.stdout.write("installed")`,
      `export default () => {}`,
    ].join("\n"))
    const runner = join(root, "plugins.mjs")
    await writeFile(runner, plugins.map(path => `import ${JSON.stringify(pathToFileURL(path === consumer ? consumer : installer).href)}`).join("\n"))
    const { stdout } = await execFileAsync(process.execPath, [runner])
    expect(stdout).toBe("installed")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
