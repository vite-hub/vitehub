import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import Module, { createRequire, registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

const moduleMockState = vi.hoisted(() => ({ unreadableRoot: false }))

vi.mock("node:module", async () => {
  const actual = await vi.importActual<typeof import("node:module")>("node:module")
  return {
    ...actual,
    createRequire(filename: string | URL) {
      const resolver = actual.createRequire(filename)
      if (!moduleMockState.unreadableRoot || filename !== "/vitehub-unreadable-build/package.json") return resolver
      return new Proxy(resolver, {
        get(target, property, receiver) {
          if (property === "resolve") {
            return () => {
              const error = new Error("Cannot read package config /vitehub-unreadable-build/package.json: permission denied") as NodeJS.ErrnoException
              error.code = "ERR_INVALID_PACKAGE_CONFIG"
              throw error
            }
          }
          return Reflect.get(target, property, receiver)
        },
      })
    },
  }
})

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
      { includePeerDependencies: true, name: "@anthropic-ai/claude-agent-sdk", resolveFrom: join(rootDir, "package.json") },
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

  it("ignores provider packages that only NODE_PATH reaches", async () => {
    // pnpm bin shims point NODE_PATH at node_modules/.pnpm/node_modules, which holds packages the app did not install.
    const target = "@anthropic-ai/claude-agent-sdk-linux-x64"
    const store = await createProject({ claude: true, claudeTarget: target, codex: true, codexTarget: "@openai/codex-linux-x64" })
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-runtime-"))
    tempDirs.push(rootDir)
    await writeFile(join(rootDir, "package.json"), "{}\n")
    const ambientModules = join(rootDir, "ambient-modules")
    await symlink(join(store.rootDir, "node_modules"), ambientModules, "junction")
    // SAFETY: Module._initPaths is the CommonJS loader hook that rereads NODE_PATH.
    const loader = Module as typeof Module & { _initPaths: () => void }
    const nodePath = process.env.NODE_PATH
    process.env.NODE_PATH = ambientModules
    loader._initPaths()
    try {
      expect(createRequire(join(rootDir, "package.json")).resolve("@anthropic-ai/claude-agent-sdk")).toBe(join(store.claudePackageDir, "sdk.mjs"))
      expect(resolveProviderRuntimePackages({ arch: "x64", libc: "glibc", platform: "linux", rootDir })).toEqual([])
      expect(resolveInstalledProviderExecutable("claude-code", {
        arch: "x64", libc: "glibc", platform: "linux", resolveFrom: join(rootDir, "package.json"),
      })).toBeUndefined()
      // The same store becomes an app installation when linked through its node_modules.
      await symlink(join(store.rootDir, "node_modules"), join(rootDir, "node_modules"), "junction")
      expect(resolveProviderRuntimePackages({ arch: "x64", libc: "glibc", platform: "linux", rootDir })).toEqual([
        { name: "@openai/codex", resolveFrom: join(rootDir, "package.json") },
        { name: "@openai/codex-linux-x64", resolveFrom: join(store.codexPackageDir, "package.json") },
        { includePeerDependencies: true, name: "@anthropic-ai/claude-agent-sdk", resolveFrom: join(rootDir, "package.json") },
        { name: target, resolveFrom: join(store.claudePackageDir, "package.json") },
      ])
      expect(resolveInstalledProviderExecutable("claude-code", {
        arch: "x64", libc: "glibc", platform: "linux", resolveFrom: join(rootDir, "package.json"),
      })).toBe(join(store.rootDir, "node_modules", ...target.split("/"), "claude"))
    }
    finally {
      if (nodePath === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = nodePath
      loader._initPaths()
    }
  })

  it("preserves provider packages reached through a customized resolver", async () => {
    const claudeTarget = "@anthropic-ai/claude-agent-sdk-linux-x64"
    const codexTarget = "@openai/codex-linux-x64"
    const store = await createProject({ claude: true, claudeTarget, codex: true, codexTarget })
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-runtime-"))
    tempDirs.push(rootDir)
    const resolveFrom = join(rootDir, "package.json")
    await writeFile(resolveFrom, "{}\n")
    const resolver = createRequire(join(store.rootDir, "package.json"))
    // Like PnP, this resolver makes installed packages available without an app node_modules tree.
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL !== pathToFileURL(resolveFrom).href) return nextResolve(specifier, context)
        return { shortCircuit: true, url: pathToFileURL(resolver.resolve(specifier)).href }
      },
    })
    try {
      expect(resolveProviderRuntimePackages({ arch: "x64", libc: "glibc", platform: "linux", rootDir })).toEqual([
        { name: "@openai/codex", resolveFrom },
        { name: codexTarget, resolveFrom: join(store.codexPackageDir, "package.json") },
        { includePeerDependencies: true, name: "@anthropic-ai/claude-agent-sdk", resolveFrom },
        { name: claudeTarget, resolveFrom: join(store.claudePackageDir, "package.json") },
      ])
      expect(resolveInstalledProviderExecutable("codex", { platform: "linux", resolveFrom }))
        .toBe(join(store.codexPackageDir, "bin", "codex.js"))
      expect(resolveInstalledProviderExecutable("claude-code", { arch: "x64", libc: "glibc", platform: "linux", resolveFrom }))
        .toBe(join(store.rootDir, "node_modules", ...claudeTarget.split("/"), "claude"))
    }
    finally {
      hooks.deregister()
    }
  })

  it("keeps host command fallbacks on Windows", async () => {
    const { rootDir } = await createProject({ claude: true, codex: true })
    const resolveFrom = pathToFileURL(join(rootDir, "server.mjs")).href

    expect(resolveInstalledProviderExecutable("codex", { platform: "win32", resolveFrom })).toBeUndefined()
    expect(resolveInstalledProviderExecutable("claude-code", { platform: "win32", resolveFrom })).toBeUndefined()
  })

  it("packages the Claude SDK without its native package for the host command fallback", async () => {
    const codex = await createProject({ codex: true })
    const claude = await createProject({ claude: true })

    expect(() => resolveProviderRuntimePackages({ arch: "x64", platform: "linux", rootDir: codex.rootDir }))
      .toThrow("@openai/codex-linux-x64 optional dependency is missing")
    expect(resolveProviderRuntimePackages({ arch: "arm64", libc: "glibc", platform: "linux", rootDir: claude.rootDir })).toEqual([
      { includePeerDependencies: true, name: "@anthropic-ai/claude-agent-sdk", resolveFrom: join(claude.rootDir, "package.json") },
    ])
  })

  it("fails explicitly for unsupported deployment hosts", async () => {
    const codex = await createProject({ codex: true })
    const claude = await createProject({ claude: true })

    expect(() => resolveProviderRuntimePackages({ arch: "riscv64", platform: "linux", rootDir: codex.rootDir }))
      .toThrow("Cannot package @openai/codex")
    expect(() => resolveProviderRuntimePackages({ arch: "x64", platform: "win32", rootDir: claude.rootDir }))
      .toThrow("Cannot package @anthropic-ai/claude-agent-sdk")
  })

  it.each(["codex", "claude-code"] as const)("preserves malformed package errors for %s", async (provider) => {
    const { rootDir } = await createProject({ claude: true, codex: true })
    const packageName = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-agent-sdk"
    await writeFile(join(rootDir, "node_modules", ...packageName.split("/"), "package.json"), "{invalid json")

    expect(() => resolveInstalledProviderExecutable(provider, {
      arch: "x64", libc: "glibc", platform: "linux", resolveFrom: join(rootDir, "package.json"),
    })).toThrow(expect.objectContaining({ code: "ERR_INVALID_PACKAGE_CONFIG" }))
  })

  it("skips an unreadable build root after a permission-specific package error", async () => {
    const codexTarget = "@openai/codex-linux-x64"
    const claudeTarget = "@anthropic-ai/claude-agent-sdk-linux-x64"
    const { codexPackageDir, rootDir } = await createProject({ claude: true, claudeTarget, codex: true, codexTarget })
    // The Vite build bakes in the directory where it ran. A release can run elsewhere as a user
    // that cannot enter that directory, so Node cannot read its nearest package.json.
    moduleMockState.unreadableRoot = true
    vi.stubGlobal("__VITEHUB_AGENT_APP_ROOT__", "/vitehub-unreadable-build")
    vi.spyOn(process, "cwd").mockReturnValue(rootDir)

    expect(resolveInstalledProviderExecutable("codex")).toBe(join(codexPackageDir, "bin", "codex.js"))
    expect(resolveInstalledProviderExecutable("claude-code", { arch: "x64", libc: "glibc", platform: "linux" }))
      .toBe(join(rootDir, "node_modules", ...claudeTarget.split("/"), "claude"))
  })
})
