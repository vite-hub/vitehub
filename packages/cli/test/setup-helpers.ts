import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"

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

/** Runs one setup command with a config loader that throws, and parses stdout as exactly one JSON document. */
export async function runSetup<T = Record<string, unknown>>(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<SetupRun<T>> {
  let stdout = ""
  let stderr = ""
  const loadConfig = vi.fn(async () => {
    throw new Error("setup commands must not load the config")
  })
  const exitCode = await runViteHubCli({
    args,
    cwd,
    env,
    loadConfig,
    stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk) } },
    stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk) } },
  })
  // JSON.parse throws when stdout holds more than one document.
  const json = (args.includes("--json") ? JSON.parse(stdout) : {}) as T
  return { exitCode, json, loadConfig, stderr, stdout }
}
