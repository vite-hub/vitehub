import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"
import process from "node:process"

import { expect, it } from "vitest"

import { expectNoLeak, fakeHosts } from "./setup-deploy-helpers.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { SetupDeployOutput } from "../src/setup/index.ts"

const repoRoot = resolve(import.meta.dirname, "../../..")

/** A real spawn for the build. Its output goes to the test log. */
const realSpawn: ViteHubCliSpawn = (command, args, options = {}) => new Promise((resolveResult, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", chunk => process.stderr.write(chunk))
  child.stderr.on("data", chunk => process.stderr.write(chunk))
  child.on("error", reject)
  child.on("close", (exitCode, signal) => resolveResult({ exitCode, signal }))
})

/** Links the workspace `node_modules` into `app` entry by entry, with a `.bin` folder that has no `wrangler`. */
async function linkWorkspaceInstall(app: string): Promise<void> {
  const root = join(repoRoot, "node_modules")
  const local = join(app, "node_modules")
  await mkdir(join(local, ".bin"), { recursive: true })
  for (const entry of await readdir(root)) {
    if (entry !== ".bin") await symlink(join(root, entry), join(local, entry))
  }
  for (const bin of await readdir(join(root, ".bin"))) {
    if (bin !== "wrangler" && !bin.startsWith("wrangler.")) await symlink(join(root, ".bin", bin), join(local, ".bin", bin))
  }
}

it("builds a `vitehub init` Cloudflare app for real and uploads it with a fake Wrangler", async () => {
  const parent = await createProject()
  const init = await runSetup(["init", "app", "--host", "cloudflare", "--features", "kv", "--pm", "pnpm", "--no-install", "--yes", "--json"], parent)
  expect(init.exitCode, init.stdout + init.stderr).toBe(0)
  const app = join(parent, "app")
  // The workspace packages stand in for the install, like the docs host fixture builds. The workspace has `vp`, the
  // Vite+ CLI, and no `vite` executable, so the build script calls `vp build`. The app gets every workspace package and
  // executable except Wrangler: deploy prefers a local executable, and the real one would reach Cloudflare.
  await linkWorkspaceInstall(app)
  expect(existsSync(join(app, "node_modules/.bin/wrangler"))).toBe(false)
  const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as { scripts: Record<string, string> }
  expect(manifest.scripts.build).toBe("vite build")
  manifest.scripts.build = "vp build"
  await writeFile(join(app, "package.json"), JSON.stringify(manifest, null, 2))

  const hosts = await fakeHosts({ CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "cf-token-1" })
  // The machine's own CI flag and host tokens must not reach the deploy.
  const { CI: _ci, CLOUDFLARE_API_TOKEN: _token, ...machine } = process.env
  const env: NodeJS.ProcessEnv = { ...machine, ...hosts.env, PATH: [hosts.env.PATH, process.env.PATH].join(delimiter) }
  const result = await runSetup<SetupDeployOutput>(["deploy", "--yes", "--json"], app, env, { spawn: realSpawn })

  expect(result.exitCode, result.stdout + result.stderr).toBe(0)
  const output = join(app, ".output")
  const nitro = JSON.parse(await readFile(join(output, "nitro.json"), "utf8")) as { commands: { deploy: string } }
  expect(nitro.commands.deploy).toBe("npx wrangler deploy --config ./server/wrangler.json")
  const wrangler = JSON.parse(await readFile(join(output, "server/wrangler.json"), "utf8")) as { name: string, main: string }
  expect(existsSync(join(output, "server", wrangler.main))).toBe(true)

  const calls = await hosts.calls()
  expect(calls.map(call => [call.argv, call.stdin, call.cwd])).toEqual([
    [["deploy", "--config", "./server/wrangler.json"], "", output],
  ])
  const url = `https://${wrangler.name}.example.workers.dev`
  expect(result.json).toEqual({
    host: "cloudflare",
    schemaVersion: 1,
    url,
    version: "version-1",
  })
  expectNoLeak(calls, result.stdout + result.stderr, ["cf-token-1"])
}, 600_000)
