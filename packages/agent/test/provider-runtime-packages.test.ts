import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { resolveInstalledProviderExecutable, resolveProviderRuntimePackages } from "../src/internal/provider-runtime-packages.ts"

const tempDirs: string[] = []

async function createProject(options: {
  claude?: boolean
  claudeTarget?: string
  codex?: boolean
  codexTarget?: string
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-runtime-"))
  tempDirs.push(rootDir)
  await writeFile(join(rootDir, "package.json"), "{}\n")
  const codexPackageDir = join(rootDir, "node_modules", "@openai", "codex")
  if (options.codex) {
    await mkdir(join(codexPackageDir, "bin"), { recursive: true })
    await writeFile(join(codexPackageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.149.1" }))
    await writeFile(join(codexPackageDir, "bin", "codex.js"), "#!/usr/bin/env node\n")
  }
  if (options.codexTarget) {
    const packageDir = join(rootDir, "node_modules", ...options.codexTarget.split("/"))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: options.codexTarget, version: "0.149.1" }))
  }
  const claudePackageDir = join(rootDir, "node_modules", "@anthropic-ai", "claude-agent-sdk")
  if (options.claude) {
    await mkdir(claudePackageDir, { recursive: true })
    await writeFile(join(claudePackageDir, "package.json"), JSON.stringify({
      exports: { ".": "./sdk.mjs" },
      name: "@anthropic-ai/claude-agent-sdk",
      type: "module",
      version: "0.3.246",
    }))
    await writeFile(join(claudePackageDir, "sdk.mjs"), "export function query() {}\n")
  }
  else {
    await mkdir(claudePackageDir, { recursive: true })
    await writeFile(join(claudePackageDir, "package.json"), JSON.stringify({
      exports: { ".": "./missing.mjs" },
      name: "@anthropic-ai/claude-agent-sdk",
      type: "module",
      version: "0.0.0",
    }))
  }
  if (options.claudeTarget) {
    const packageDir = join(rootDir, "node_modules", ...options.claudeTarget.split("/"))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: options.claudeTarget, version: "0.3.246" }))
    await writeFile(join(packageDir, "claude"), "native fixture\n")
  }
  return { claudePackageDir, codexPackageDir, rootDir }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Provider runtime packages", () => {
  it("uses an installed Codex CLI and selects one native package", async () => {
    const target = "@openai/codex-linux-x64"
    const { codexPackageDir, rootDir } = await createProject({ codex: true, codexTarget: target })
    const resolveFrom = pathToFileURL(join(rootDir, "server.mjs")).href

    expect(resolveInstalledProviderExecutable("codex", { resolveFrom })).toBe(join(codexPackageDir, "bin", "codex.js"))
    expect(resolveProviderRuntimePackages({ arch: "x64", platform: "linux", rootDir })).toEqual([
      { name: "@openai/codex", resolveFrom: join(rootDir, "package.json") },
      { name: target, resolveFrom: join(codexPackageDir, "package.json") },
    ])
  })

  it("uses an installed Claude SDK and selects the host libc package", async () => {
    const target = "@anthropic-ai/claude-agent-sdk-linux-x64-musl"
    const { claudePackageDir, rootDir } = await createProject({ claude: true, claudeTarget: target })
    const resolveFrom = pathToFileURL(join(rootDir, "server.mjs")).href

    expect(resolveInstalledProviderExecutable("claude-code", { arch: "x64", libc: "musl", platform: "linux", resolveFrom }))
      .toBe(join(rootDir, "node_modules", ...target.split("/"), "claude"))
    expect(resolveProviderRuntimePackages({ arch: "x64", libc: "musl", platform: "linux", rootDir })).toEqual([
      { name: "@anthropic-ai/claude-agent-sdk", resolveFrom: join(rootDir, "package.json") },
      { name: target, resolveFrom: join(claudePackageDir, "package.json") },
    ])
  })

  it("leaves host command fallbacks when provider packages are absent", async () => {
    const { rootDir } = await createProject()
    const resolveFrom = pathToFileURL(join(rootDir, "server.mjs")).href

    expect(resolveInstalledProviderExecutable("codex", { resolveFrom })).toBeUndefined()
    expect(resolveInstalledProviderExecutable("claude-code", { resolveFrom })).toBeUndefined()
    expect(resolveProviderRuntimePackages({ rootDir })).toEqual([])
  })

  it("keeps host command fallbacks on Windows", async () => {
    const { rootDir } = await createProject({ claude: true, codex: true })
    const resolveFrom = pathToFileURL(join(rootDir, "server.mjs")).href

    expect(resolveInstalledProviderExecutable("codex", { platform: "win32", resolveFrom })).toBeUndefined()
    expect(resolveInstalledProviderExecutable("claude-code", { platform: "win32", resolveFrom })).toBeUndefined()
  })

  it("fails when an installed provider lacks its native package", async () => {
    const codex = await createProject({ codex: true })
    const claude = await createProject({ claude: true })

    expect(() => resolveProviderRuntimePackages({ arch: "x64", platform: "linux", rootDir: codex.rootDir }))
      .toThrow("@openai/codex-linux-x64 optional dependency is missing")
    expect(() => resolveProviderRuntimePackages({ arch: "arm64", libc: "glibc", platform: "linux", rootDir: claude.rootDir }))
      .toThrow("@anthropic-ai/claude-agent-sdk-linux-arm64 optional dependency is missing")
  })

  it("fails explicitly for unsupported deployment hosts", async () => {
    const codex = await createProject({ codex: true })
    const claude = await createProject({ claude: true })

    expect(() => resolveProviderRuntimePackages({ arch: "riscv64", platform: "linux", rootDir: codex.rootDir }))
      .toThrow("Cannot package @openai/codex")
    expect(() => resolveProviderRuntimePackages({ arch: "x64", platform: "win32", rootDir: claude.rootDir }))
      .toThrow("Cannot package @anthropic-ai/claude-agent-sdk")
  })
})
