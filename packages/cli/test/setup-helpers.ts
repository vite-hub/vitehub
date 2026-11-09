import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { HostCliRun } from "@vite-hub/internal/host-credentials"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

/** A temp folder with `files`, keyed by relative path. */
export async function createProject(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cli-setup-"))
  directories.push(root)
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }
  return root
}

export const pnpmManifest: string = JSON.stringify({ name: "app", packageManager: "pnpm@10.0.0", type: "module" })

export function viteConfig(options: string): string {
  return `import { defineConfig } from "vite"\nimport { vitehub } from "vite-hub"\n\nexport default defineConfig({\n  plugins: [vitehub(${options})],\n})\n`
}

interface SetupRun<T> {
  exitCode: number
  /** The one JSON document on stdout with `--json`. */
  json: T
  loadConfig: ReturnType<typeof vi.fn>
  stderr: string
  stdout: string
}

/** A spawn that fails the test, so a setup test never runs a real package manager. */
const noSpawn: ViteHubCliSpawn = async (command) => {
  throw new Error(`setup tests must not spawn ${command}`)
}

interface FakeManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * A package manager that only edits `package.json` in `root`, so a test can check the manifest after `add` and
 * `remove` without a real install. It understands `add`, `install`, `remove`, and `uninstall`, with `-D` for development.
 * An empty dependency field is deleted, so a round trip gives back the original bytes.
 */
export function fakePackageManager(root: string): { calls: string[][], spawn: ViteHubCliSpawn } {
  const calls: string[][] = []
  const spawn: ViteHubCliSpawn = async (command, args) => {
    calls.push([command, ...args])
    const [verb, ...rest] = args
    const dev = rest[0] === "-D" || rest[0] === "-d"
    const names = dev ? rest.slice(1) : rest
    const file = join(root, "package.json")
    const manifest = JSON.parse(await readFile(file, "utf8")) as FakeManifest
    if (verb === "add" || verb === "install") {
      const field = dev ? "devDependencies" : "dependencies"
      manifest[field] = { ...manifest[field], ...Object.fromEntries(names.map(name => [name, "1.0.0"])) }
    }
    else if (verb === "remove" || verb === "uninstall") {
      for (const field of ["dependencies", "devDependencies"] as const) {
        for (const name of names) delete manifest[field]?.[name]
        if (manifest[field] && !Object.keys(manifest[field]).length) delete manifest[field]
      }
    }
    else {
      throw new Error(`fake package manager does not know ${command} ${args.join(" ")}`)
    }
    await writeFile(file, JSON.stringify(manifest))
    return { exitCode: 0 }
  }
  return { calls, spawn }
}

/** A host CLI runner for a machine without a host CLI login. Tests never run a real host CLI. */
export const noHostCli: HostCliRun = async () => ({ exitCode: 1, stdout: "" })

interface SetupRunOptions {
  fetch?: typeof fetch
  runHostCli?: HostCliRun
  spawn?: ViteHubCliSpawn
}

/** Runs one setup command with a config loader that throws, and parses stdout as exactly one JSON document. */
export async function runSetup<T = Record<string, unknown>>(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, options: SetupRunOptions = {}): Promise<SetupRun<T>> {
  let stdout = ""
  let stderr = ""
  const loadConfig = vi.fn(async () => {
    throw new Error("setup commands must not load the config")
  })
  const exitCode = await runViteHubCli({
    args,
    cwd,
    env,
    // A fetch that fails, so no test reaches a real host.
    fetch: options.fetch ?? (async (input: string | URL | Request) => {
      throw new Error(`unexpected request to ${String(input)}`)
    }),
    loadConfig,
    runHostCli: options.runHostCli ?? noHostCli,
    spawn: options.spawn ?? noSpawn,
    stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk) } },
    stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk) } },
  })
  // JSON.parse throws when stdout holds more than one document.
  const json = (args.includes("--json") ? JSON.parse(stdout) : {}) as T
  return { exitCode, json, loadConfig, stderr, stdout }
}
