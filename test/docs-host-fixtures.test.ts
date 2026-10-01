import { execFile, spawn, type ChildProcess } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { describe, expect, it, type TestContext } from "vitest"
import { array, object, parse, picklist, string } from "valibot"

const repoRoot = resolve(import.meta.dirname, "..")
const fixturesRoot = join(repoRoot, "fixtures/docs-hosts")
const vpExecutable = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "vp.cmd" : "vp")
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

const snippetContractsSchema = array(object({
  fixture: string(),
  label: string(),
  page: string(),
  verification: picklist(["build", "json", "typecheck"]),
}))

function parseSnippetContracts(source: string): SnippetContract[] {
  return parse(snippetContractsSchema, JSON.parse(source))
}

type FixtureTestContext = Pick<TestContext, "onTestFinished" | "signal">

function ownProcess(child: ChildProcess, context: FixtureTestContext) {
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  let stopping: Promise<void> | undefined
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return false
    try {
      process.kill(-child.pid, signal)
      return true
    }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
      throw error
    }
  }
  const stop = () => stopping ||= (async () => {
    try {
      if (process.platform === "win32") {
        // Windows taskkill only owns a live parent tree. Unlike a POSIX process
        // group, it cannot reliably reclaim descendants after that parent exits.
        // The bounded close wait below reports any inherited pipes left open.
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve, reject) => {
            execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { timeout: 5_000, windowsHide: true }, (error) => {
              if (error && child.exitCode === null && child.signalCode === null) reject(error)
              else resolve()
            })
          })
        }
      }
      else if (signalGroup("SIGTERM")) {
        await new Promise(resolve => setTimeout(resolve, 250))
        // Descendants can ignore SIGTERM after their parent has already exited.
        signalGroup("SIGKILL")
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Fixture process ${child.pid} did not close after cleanup`)), 5_000)
        void closed.then(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    finally {
      context.signal.removeEventListener("abort", abort)
    }
  })()
  const abort = () => { void stop().catch(() => {}) }
  context.signal.addEventListener("abort", abort, { once: true })
  context.onTestFinished(stop)
  if (context.signal.aborted) abort()
  return stop
}

async function run(command: string, args: string[], context: FixtureTestContext, cwd = repoRoot, env: NodeJS.ProcessEnv = {}, shell = false) {
  context.signal.throwIfAborted()
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, ...env },
    shell,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stop = ownProcess(child, context)
  let output = ""
  child.stdout.on("data", chunk => output += chunk)
  child.stderr.on("data", chunk => output += chunk)
  try {
    const result = await new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject)
      // POSIX process-group cleanup also owns descendants retaining stdout.
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    context.signal.throwIfAborted()
    if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.signal ?? `code ${result.code}`}\n${output}`)
  }
  finally {
    await stop()
  }
}

async function expectDenoLauncherToStart(appRoot: string, context: FixtureTestContext) {
  context.signal.throwIfAborted()
  const startup = new AbortController()
  const startupSignal = AbortSignal.any([context.signal, startup.signal])
  const port = 8000
  const child = spawn("deno", [
    "run",
    "--cached-only",
    "--unstable-cron",
    "--allow-env",
    "--allow-read=.output",
    `--allow-net=0.0.0.0:${port}`,
    ".output/main.ts",
  ], {
    cwd: appRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      DENO_NO_UPDATE_CHECK: "1",
      HOST: "127.0.0.1",
      PORT: String(port),
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stop = ownProcess(child, context)
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
        startupSignal.throwIfAborted()
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.any([startupSignal, AbortSignal.timeout(1_000)]),
          })
          if ((await response.text()).includes("ViteHub host fixture")) return
        }
        catch {
          startupSignal.throwIfAborted()
          await delay(100, undefined, { signal: startupSignal })
        }
      }
      throw new Error(`Deno launcher did not serve its fixture on port ${port}\n${output}`)
    })()
    await Promise.race([
      exit.then(({ code, signal }) => {
        throw new Error(`Deno launcher exited with ${signal ?? `code ${code}`}\n${output}`)
      }),
      started,
    ])
  }
  finally {
    startup.abort()
    await stop()
  }
}

describe("host documentation fixtures", () => {
  it.for(["test signal aborts", "parent exits"] as const)("stops command descendants when the %s", async (finish, context) => {
    if (finish === "parent exits" && process.platform === "win32") context.skip()
    const root = await mkdtemp(join(tmpdir(), "vitehub-doc-host-abort-"))
    const heartbeat = join(root, "heartbeat")
    const controller = new AbortController()
    const reason = new Error("fixture test expired")
    const descendant = [
      'const { writeFileSync } = require("node:fs")',
      'process.on("SIGTERM", () => {})',
      'let count = 0; const beat = () => writeFileSync(process.argv[1], String(++count))',
      'beat(); process.send("ready", () => {}); setInterval(beat, 10)',
      "setTimeout(() => process.exit(0), 10_000)",
    ].join("; ")
    const parent = [
      'const { spawn } = require("node:child_process")',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: ["ignore", "inherit", "inherit", "ipc"] })`,
      ...(finish === "parent exits" ? ['child.once("message", () => process.exit(0))'] : []),
      "setTimeout(() => process.exit(0), 10_000)",
    ].join("; ")
    const result = run(process.execPath, ["-e", parent, heartbeat], {
      onTestFinished: context.onTestFinished,
      signal: AbortSignal.any([context.signal, controller.signal]),
    }).then(() => undefined, error => error)

    try {
      while (!/^\d+$/.test(await readFile(heartbeat, "utf8").catch(() => ""))) {
        await delay(10, undefined, { signal: context.signal })
      }
      if (finish === "test signal aborts") controller.abort(reason)
      expect(await result).toBe(finish === "test signal aborts" ? reason : undefined)
      const stopped = await readFile(heartbeat, "utf8")
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(await readFile(heartbeat, "utf8")).toBe(stopped)
    }
    finally {
      controller.abort(reason)
      await result
      await rm(root, { force: true, recursive: true })
    }
  }, 15_000)

  it("typechecks every maintained source and configuration form", async (context) => {
    const sources = (await readdir(fixturesRoot, { recursive: true }))
      .filter(path => path.endsWith(".ts") && !path.endsWith(".d.ts"))
      .sort()

    await run(process.execPath, [
      join(repoRoot, "node_modules/typescript/bin/tsc"),
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
      ...sources.map(source => join(fixturesRoot, source)),
    ], context)
  }, 120_000)

  it.for(hostFixtures)("builds the %s credential-free fixture", async (host, context) => {
    const root = await mkdtemp(join(tmpdir(), `vitehub-doc-host-${host}-`))
    const appRoot = join(root, host)

    try {
      await cp(join(fixturesRoot, host), appRoot, { recursive: true })
      await symlink(join(repoRoot, "node_modules"), join(appRoot, "node_modules"), "dir")
      await mkdir(join(appRoot, "src"), { recursive: true })
      await writeFile(join(appRoot, "index.html"), '<main id="app">ViteHub host fixture</main><script type="module" src="/src/main.ts"></script>\n', "utf8")
      await writeFile(join(appRoot, "src/main.ts"), 'document.querySelector("#app")!.textContent = "ViteHub host fixture"\n', "utf8")

      await run(
        vpExecutable,
        ["build", appRoot, "--config", join(appRoot, "vite.config.ts")],
        context,
        repoRoot,
        { VITEHUB_HOSTING: host === "node-self-hosted" ? "node" : host },
        process.platform === "win32",
      )

      for (const artifact of hostArtifacts[host]) {
        await expect(
          readFile(join(appRoot, artifact), "utf8"),
          `${host} should emit ${artifact}`,
        ).resolves.not.toHaveLength(0)
      }
      if (host === "deno") await expectDenoLauncherToStart(appRoot, context)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 900_000)

  it("declares exactly one representative build per documented host", async () => {
    const contracts = parseSnippetContracts(await readFile(join(fixturesRoot, "manifest.json"), "utf8"))
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
