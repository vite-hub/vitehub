import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, symlink, writeFile } from "node:fs/promises"
import { delimiter, join, resolve } from "node:path"
import process from "node:process"

import { expect, it } from "vitest"

import { expectNoLeak, fakeHosts, HASH, PENDING_ID } from "./setup-deploy-helpers.ts"
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

it("builds a `vitehub init` Cloudflare app for real and uploads it with a fake Wrangler", async () => {
  // The fake must be the Wrangler that deploy finds. A real one in the workspace would reach Cloudflare.
  expect(existsSync(join(repoRoot, "node_modules/.bin/wrangler"))).toBe(false)

  const parent = await createProject()
  const init = await runSetup(["init", "app", "--host", "cloudflare", "--features", "kv", "--pm", "pnpm", "--console", `${PENDING_ID}:sha256:${HASH}`, "--no-install", "--yes", "--json"], parent)
  expect(init.exitCode, init.stdout + init.stderr).toBe(0)
  const app = join(parent, "app")
  // The workspace packages stand in for the install, like the docs host fixture builds. The workspace has `vp`, the
  // Vite+ CLI, and no `vite` executable, so the build script calls `vp build`.
  await symlink(join(repoRoot, "node_modules"), join(app, "node_modules"), "dir")
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
    [["secret", "put", "VITEHUB_CONSOLE_TOKEN_SHA256", "--config", "./server/wrangler.json"], HASH, output],
    [["secret", "list", "--config", "./server/wrangler.json", "--format", "json"], "", output],
    [["deploy", "--config", "./server/wrangler.json"], "", output],
  ])
  const url = `https://${wrangler.name}.example.workers.dev`
  expect(result.json).toEqual({
    console: { linkUrl: `https://console.vitehub.dev/link#p=${PENDING_ID}&url=${encodeURIComponent(url)}`, secret: "set" },
    host: "cloudflare",
    schemaVersion: 1,
    url,
    version: "version-1",
  })
  expectNoLeak(calls, result.stdout + result.stderr, [HASH, "cf-token-1"])
}, 600_000)
