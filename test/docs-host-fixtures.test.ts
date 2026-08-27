import { execFile, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const fixturesRoot = join(repoRoot, "fixtures/docs-hosts")
const hostFixtures = ["cloudflare", "vercel", "netlify", "deno", "node-self-hosted"] as const
const hostArtifacts: Record<(typeof hostFixtures)[number], string[]> = {
  cloudflare: [".output/server/wrangler.json"],
  deno: [".output/server/index.mjs", ".output/main.ts", ".output/schedule/deno-cron.mjs"],
  netlify: [
    ".netlify/v1/functions/vitehub-agent.mjs",
    ".netlify/v1/functions/vitehub-schedule-heartbeat.mjs",
  ],
  "node-self-hosted": [".output/server/index.mjs"],
  vercel: [
    ".vercel/output/config.json",
    ".vercel/output/functions/__server.func/index.mjs",
  ],
}

interface SnippetContract {
  fixture: string
  label: string
  page: string
  verification: "build" | "json" | "typecheck"
}

async function run(command: string, args: string[], cwd = repoRoot, env: NodeJS.ProcessEnv = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    })
  }
  catch (error) {
    const failure = error as Error & { stderr?: string, stdout?: string }
    throw new Error(`${command} ${args.join(" ")} failed\n${failure.stdout || ""}${failure.stderr || ""}`, { cause: error })
  }
}

async function expectDenoLauncherToStart(appRoot: string) {
  const child = spawn("deno", [
    "run",
    "--unstable-cron",
    "--allow-env",
    "--allow-read=.output",
    "--allow-net=0.0.0.0:8000",
    ".output/main.ts",
  ], {
    cwd: appRoot,
    env: { ...process.env, HOST: "0.0.0.0", PORT: "8000" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", chunk => output += chunk)
  child.stderr.on("data", chunk => output += chunk)
  const exit = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })

  try {
    const started = (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await fetch("http://127.0.0.1:8000/")
          return
        }
        catch {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      throw new Error(`Deno launcher did not listen on port 8000\n${output}`)
    })()
    await Promise.race([
      exit.then(({ code, signal }) => {
        throw new Error(`Deno launcher exited with ${signal ?? `code ${code}`}\n${output}`)
      }),
      started,
    ])
  }
  finally {
    child.kill("SIGTERM")
    await exit
  }
}

describe("host documentation fixtures", () => {
  it("typechecks every maintained source and configuration form", async () => {
    const sources = (await readdir(fixturesRoot, { recursive: true }))
      .filter(path => path.endsWith(".ts") && !path.endsWith(".d.ts"))
      .sort()

    for (let index = 0; index < sources.length; index += 4) {
      await Promise.all(sources.slice(index, index + 4).map(source => run("corepack", [
        "pnpm",
        "exec",
        "tsc",
        "--ignoreConfig",
        "--noEmit",
        "--skipLibCheck",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--target",
        "ES2023",
        "--types",
        "node",
        join(fixturesRoot, "globals.d.ts"),
        join(fixturesRoot, source),
      ])))
    }
  }, 120_000)

  it("builds one credential-free fixture for every documented host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-doc-hosts-"))

    try {
      for (const host of hostFixtures) {
        const appRoot = join(root, host)
        await cp(join(fixturesRoot, host), appRoot, { recursive: true })
        await symlink(join(repoRoot, "node_modules"), join(appRoot, "node_modules"), "dir")
        await mkdir(join(appRoot, "src"), { recursive: true })
        await writeFile(join(appRoot, "index.html"), '<main id="app"></main><script type="module" src="/src/main.ts"></script>\n', "utf8")
        await writeFile(join(appRoot, "src/main.ts"), 'document.querySelector("#app")!.textContent = "ViteHub host fixture"\n', "utf8")

        await run("corepack", ["pnpm", "exec", "vp", "build", appRoot, "--config", join(appRoot, "vite.config.ts")], repoRoot, {
          VITEHUB_HOSTING: host === "node-self-hosted" ? "node" : host,
        })

        for (const artifact of hostArtifacts[host]) {
          await expect(
            readFile(join(appRoot, artifact), "utf8"),
            `${host} should emit ${artifact}`,
          ).resolves.not.toHaveLength(0)
        }
        if (host === "deno") await expectDenoLauncherToStart(appRoot)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  it("declares exactly one representative build per documented host", async () => {
    const contracts = JSON.parse(await readFile(join(fixturesRoot, "manifest.json"), "utf8")) as SnippetContract[]
    const builtHosts = contracts
      .filter(contract => contract.verification === "build")
      .map(contract => contract.fixture.split("/")[0])
      .sort()

    expect(builtHosts).toEqual([...hostFixtures].sort())
    expect(contracts.filter(contract => contract.verification === "json")).toHaveLength(1)
    expect(contracts.every(contract => !contract.fixture.startsWith("../") && !contract.page.startsWith("../"))).toBe(true)

    for (const contract of contracts.filter(contract => contract.verification === "json")) {
      const source = await readFile(join(fixturesRoot, contract.fixture), "utf8")
      expect(() => JSON.parse(source), contract.fixture).not.toThrow()
    }
  })
})
