import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import process from "node:process"

import { expect } from "vitest"

import { createProject } from "./setup-helpers.ts"

/** The SHA-256 that `vitehub init --console` stores. No argv and no CLI output may show it. */
export const HASH = "9b74c9897bac770ffc029102a200c5de1c4f6ed3cf5bd2c7a6c3f0e4d2b1a098"
export const PENDING_ID = "pending_42"

export interface FakeCall {
  name: string
  argv: string[]
  stdin: string
  cwd: string
}

export interface FakeHosts {
  /** The env for `runSetup`: PATH with the fake CLIs and git, and where the fakes record their calls. */
  env: NodeJS.ProcessEnv
  calls: () => Promise<FakeCall[]>
  state: () => Promise<{ secrets: Record<string, string>, deploys: number }>
}

const fakeCli = join(import.meta.dirname, "fixtures", "fake-host-cli.cjs")

/** Writes fake `wrangler`, `vercel`, `netlify`, and `deno` executables into a folder and puts it first on PATH. */
export async function fakeHosts(env: NodeJS.ProcessEnv = {}): Promise<FakeHosts> {
  const folder = await createProject()
  const bin = join(folder, "bin")
  await mkdir(bin)
  for (const name of ["wrangler", "vercel", "netlify", "deno"]) {
    const file = join(bin, name)
    await writeFile(file, `#!${process.execPath}\nprocess.env.FAKE_HOST_NAME = ${JSON.stringify(name)}\nrequire(${JSON.stringify(fakeCli)})\n`)
    await chmod(file, 0o755)
  }
  const log = join(folder, "calls.jsonl")
  const state = join(folder, "state.json")
  await writeFile(log, "")
  return {
    calls: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as FakeCall),
    env: { FAKE_HOST_LOG: log, FAKE_HOST_STATE: state, LC_ALL: "C", PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), ...env },
    state: async () => existsSync(state) ? JSON.parse(await readFile(state, "utf8")) as { secrets: Record<string, string>, deploys: number } : { deploys: 0, secrets: {} },
  }
}

const denoRunner = `import { spawn } from "node:child_process"

// The interface of the runner that ViteHub's Deno build writes: DENO_DEPLOY_ORG and DENO_DEPLOY_APP, then
// \`deno deploy create\`, and \`deno deploy --prod\` when the app exists.
const common = ["--allow-node-modules", "--org", process.env.DENO_DEPLOY_ORG, "--app", process.env.DENO_DEPLOY_APP]
const run = args => new Promise(resolve => spawn("deno", args, { stdio: "inherit" }).on("exit", code => resolve(code)))
if (await run(["deploy", "create", ".", "--source", "local", ...common]) !== 0) {
  const code = await run(["deploy", ".", "--prod", "--config", "deno.json", ...common])
  if (code !== 0) process.exit(code)
}
`

/** The build output files of each host, as ViteHub's build writes them, without the server bundle. */
export function buildOutput(host: "cloudflare" | "vercel" | "netlify" | "deno", deployCommand = "npx wrangler deploy --config ./server/wrangler.json"): Record<string, string> {
  const manifest = (dir: string) => ({ [`${dir}/deployment.json`]: JSON.stringify({ host, identity: { name: "my-app", source: "package" }, preset: host }) })
  switch (host) {
    case "cloudflare": return {
      ...manifest(".output"),
      ".output/nitro.json": JSON.stringify({ commands: { deploy: deployCommand }, preset: "cloudflare-module" }),
      ".output/server/wrangler.json": JSON.stringify({ main: "index.mjs", name: "my-app" }),
    }
    case "vercel": return {
      ...manifest(".vercel/output"),
      ".vercel/output/config.json": JSON.stringify({ version: 3 }),
      ".vercel/output/functions/__server.func/.vc-config.json": JSON.stringify({ handler: "index.mjs", runtime: "nodejs22.x" }),
    }
    case "netlify": return { ...manifest(".netlify"), "dist/index.html": "<h1>app</h1>\n" }
    case "deno": return { ...manifest(".output"), ".output/deploy.mjs": denoRunner }
  }
}

/** A built project for `host`. */
export async function builtProject(host: "cloudflare" | "vercel" | "netlify" | "deno", files: Record<string, string> = {}): Promise<string> {
  return await createProject({
    "package.json": JSON.stringify({ name: "my-app", packageManager: "pnpm@10.0.0", scripts: { build: "vite build" }, type: "module" }),
    "vite.config.ts": `import { defineConfig } from "vite"\nimport { vitehub } from "vite-hub"\n\nexport default defineConfig({ plugins: [vitehub({ preset: "${host}" })] })\n`,
    ".gitignore": ".output\n.vercel\n.netlify\ndist\n.vitehub\n",
    ...buildOutput(host),
    ...files,
  })
}

export function consoleLink(): Record<string, string> {
  return { ".vitehub/link.json": JSON.stringify({ console: { pendingId: PENDING_ID, tokenSha256: HASH }, schemaVersion: 1 }) }
}

/** The Console hash and the tokens appear in no argv, no CLI output, and no request URL. */
export function expectNoLeak(calls: readonly FakeCall[], output: string, values: readonly string[] = [HASH]): void {
  for (const value of values) {
    for (const call of calls) expect(call.argv.join(" "), `${call.name} ${call.argv.join(" ")}`).not.toContain(value)
    expect(output).not.toContain(value)
  }
}
