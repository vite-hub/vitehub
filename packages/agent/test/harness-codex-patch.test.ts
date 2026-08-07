import { createCodex } from "@ai-sdk/harness-codex"
import { execFile } from "node:child_process"
import { build } from "esbuild"
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"

import { createCodexDriver } from "../src/harness/codex.ts"
import { createLocalHarnessSandbox } from "../src/harness/local-sandbox.ts"

import type { HarnessV1SandboxProvider } from "@ai-sdk/harness"

const exec = promisify(execFile)
const codexBridgeInstallCommand = "if command -v corepack >/dev/null 2>&1 && corepack pnpm@10.33.2 --dir /tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir /tmp/harness/codex/.pnpm-store; then :; else pnpm --dir /tmp/harness/codex install --ignore-workspace --frozen-lockfile --store-dir /tmp/harness/codex/.pnpm-store; fi"

function withoutPreinstalledDependencies(command: string, path: string): string {
  return command.replace(/(?<=\$\{VITEHUB_CODEX_BRIDGE_NODE_MODULES:-)[^}]*/, path)
}

describe("ViteHub Codex harness", () => {
  it("bootstraps inside the sandbox workspace with the supported bridge", async () => {
    const harness = createCodexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
    const bootstrap = await harness.getBootstrap!()
    const bridgePackage = bootstrap.files.find(file => file.path.endsWith("package.json"))
    const bridge = bootstrap.files.find(file => file.path.endsWith("bridge.mjs"))

    expect(bootstrap.bootstrapDir).toBe("/tmp/harness/codex")
    expect(bootstrap.commands[1]!.command).toContain(codexBridgeInstallCommand)
    const defaultNodeModules = bootstrap.commands[1]!.command.match(/^codex_bridge_node_modules="\$\{VITEHUB_CODEX_BRIDGE_NODE_MODULES:-([^}]+)\}"/)?.[1]
    expect(defaultNodeModules).toBeDefined()
    await expect(Promise.all([
      readFile(join(defaultNodeModules!, "@openai/codex-sdk/package.json")),
      readFile(join(defaultNodeModules!, "ws/package.json")),
    ])).resolves.toHaveLength(2)
    expect(bootstrap.commands[1]!.command).toContain("VITEHUB_CODEX_BRIDGE_NODE_MODULES")
    expect(JSON.parse(bridgePackage!.content)).toMatchObject({
      dependencies: { "@openai/codex-sdk": "0.144.5" },
    })
    expect(bootstrap.files.map(file => file.path)).not.toContain("/tmp/harness/codex/host-tool-mcp.mjs")
    expect(bridge!.content).not.toContain("mcp_servers")
  })

  it("loads bridge assets after the adapter is bundled into another directory", async () => {
    const fixture = await mkdtemp(join(import.meta.dirname, ".codex-bundle-"))
    const output = join(fixture, "server", "_libs", "adapter.mjs")

    try {
      await build({
        bundle: true,
        format: "esm",
        outfile: output,
        platform: "node",
        stdin: {
          contents: `
            import { createCodexDriver } from "../src/harness/codex.ts"
            export const bootstrap = await createCodexDriver({ sandbox: false }).harness.getBootstrap()
          `,
          resolveDir: import.meta.dirname,
        },
      })

      const bundled = await import(`${pathToFileURL(output).href}?${Date.now()}`)
      expect(bundled.bootstrap.files.map((file: { path: string }) => file.path)).toContain("/tmp/harness/codex/bridge.mjs")
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  }, 15_000)

  it("loads bridge assets through package-scoped resolution in the built package", async () => {
    const dist = new URL("../dist/", import.meta.url)
    const sourceHarness = createCodexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
    const sourceBootstrap = await sourceHarness.getBootstrap!()
    const chunks = await Promise.all(
      (await readdir(dist))
        .filter(file => file.endsWith(".js"))
        .map(async file => ({ file, source: await readFile(new URL(file, dist), "utf8") })),
    )
    const codexChunk = chunks.find(chunk => chunk.source.includes("readCodexBridgeAsset"))

    expect(codexChunk?.source).toContain("harness-codex-bridge")

    const { stdout } = await exec(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        const { createCodexDriver } = await import(process.argv[1])
        const bootstrap = await createCodexDriver({ sandbox: false }).harness.getBootstrap()
        process.stdout.write(JSON.stringify({
          command: bootstrap.commands[1].command,
          package: JSON.parse(bootstrap.files.find(file => file.path.endsWith("package.json")).content),
        }))
      `,
      new URL(codexChunk!.file, dist).href,
    ])

    const builtBootstrap = JSON.parse(stdout)
    expect(builtBootstrap.command).toBe(sourceBootstrap.commands[1]!.command)
    expect(builtBootstrap).toMatchObject({
      package: {
        dependencies: { "@openai/codex-sdk": expect.any(String) },
      },
    })
  })

  it.each([
    { corepackExit: 0, expected: "corepack" },
    { corepackExit: 1, expected: "pnpm" },
  ])("uses pinned Corepack first and falls back to ambient pnpm", async ({ corepackExit, expected }) => {
    const fixture = await mkdtemp(join(import.meta.dirname, ".codex-install-"))
    const bin = join(fixture, "bin")
    const marker = join(fixture, "installer.txt")

    try {
      await mkdir(bin)
      await writeFile(join(bin, "corepack"), `#!/bin/sh\nprintf corepack > "$INSTALLER_MARKER"\nexit ${corepackExit}\n`)
      await writeFile(join(bin, "pnpm"), "#!/bin/sh\nprintf pnpm > \"$INSTALLER_MARKER\"\n")
      await Promise.all([chmod(join(bin, "corepack"), 0o755), chmod(join(bin, "pnpm"), 0o755)])

      const harness = createCodexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
      const bootstrap = await harness.getBootstrap!()
      const command = withoutPreinstalledDependencies(bootstrap.commands[1]!.command, join(fixture, "missing-node_modules"))
      await exec("/bin/sh", ["-c", command], {
        cwd: fixture,
        env: { INSTALLER_MARKER: marker, PATH: bin },
      })

      await expect(readFile(marker, "utf8")).resolves.toBe(expected)
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it("reuses preinstalled bridge dependencies without invoking an installer", async () => {
    const fixture = await mkdtemp(join(import.meta.dirname, ".codex-preinstalled-"))
    const bootstrapDir = join(fixture, "bootstrap")
    const nodeModules = join(fixture, "node_modules")
    const bin = join(fixture, "bin")
    const installerMarker = join(fixture, "installer.txt")

    try {
      await Promise.all([
        mkdir(join(nodeModules, "@openai", "codex-sdk"), { recursive: true }),
        mkdir(join(nodeModules, "ws"), { recursive: true }),
        mkdir(bin),
        mkdir(bootstrapDir),
      ])
      await writeFile(join(nodeModules, "@openai", "codex-sdk", "package.json"), "{}")
      await writeFile(join(nodeModules, "ws", "package.json"), "{}")
      await writeFile(join(bin, "corepack"), "#!/bin/sh\nprintf corepack > \"$INSTALLER_MARKER\"\nexit 1\n")
      await writeFile(join(bin, "pnpm"), "#!/bin/sh\nprintf pnpm > \"$INSTALLER_MARKER\"\nexit 1\n")
      await Promise.all([chmod(join(bin, "corepack"), 0o755), chmod(join(bin, "pnpm"), 0o755)])

      const harness = createCodexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
      const bootstrap = await harness.getBootstrap!()
      const command = bootstrap.commands[1]!.command.replaceAll("/tmp/harness/codex", bootstrapDir)
      const env = {
        INSTALLER_MARKER: installerMarker,
        PATH: [bin, process.env.PATH].filter(Boolean).join(":"),
        VITEHUB_CODEX_BRIDGE_NODE_MODULES: nodeModules,
      }

      await exec("/bin/sh", ["-c", command], { env })
      await exec("/bin/sh", ["-c", command], { env })

      await expect(readlink(join(bootstrapDir, "node_modules"))).resolves.toBe(nodeModules)
      await expect(readFile(installerMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it("fails invalid preinstalled bridge dependencies before invoking an installer", async () => {
    const fixture = await mkdtemp(join(import.meta.dirname, ".codex-invalid-preinstalled-"))
    const bootstrapDir = join(fixture, "bootstrap")
    const nodeModules = join(fixture, "node_modules")
    const bin = join(fixture, "bin")
    const installerMarker = join(fixture, "installer.txt")

    try {
      await Promise.all([mkdir(nodeModules), mkdir(bin), mkdir(bootstrapDir)])
      await writeFile(join(bin, "corepack"), "#!/bin/sh\nprintf corepack > \"$INSTALLER_MARKER\"\nexit 1\n")
      await writeFile(join(bin, "pnpm"), "#!/bin/sh\nprintf pnpm > \"$INSTALLER_MARKER\"\nexit 1\n")
      await Promise.all([chmod(join(bin, "corepack"), 0o755), chmod(join(bin, "pnpm"), 0o755)])

      const harness = createCodexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
      const bootstrap = await harness.getBootstrap!()
      const command = bootstrap.commands[1]!.command.replaceAll("/tmp/harness/codex", bootstrapDir)

      await expect(exec("/bin/sh", ["-c", command], {
        env: {
          INSTALLER_MARKER: installerMarker,
          PATH: [bin, process.env.PATH].filter(Boolean).join(":"),
          VITEHUB_CODEX_BRIDGE_NODE_MODULES: nodeModules,
        },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("VITEHUB_CODEX_BRIDGE_NODE_MODULES must contain the Codex bridge dependencies"),
      })
      await expect(exec("/bin/sh", ["-c", command], {
        env: {
          INSTALLER_MARKER: installerMarker,
          PATH: [bin, process.env.PATH].filter(Boolean).join(":"),
          VITEHUB_CODEX_BRIDGE_NODE_MODULES: "relative/node_modules",
        },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("VITEHUB_CODEX_BRIDGE_NODE_MODULES must be an absolute sandbox path"),
      })
      await expect(readFile(installerMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it("rejects a conflicting bridge dependency target", async () => {
    const fixture = await mkdtemp(join(import.meta.dirname, ".codex-conflicting-preinstalled-"))
    const bootstrapDir = join(fixture, "bootstrap")
    const nodeModules = join(fixture, "node_modules")

    try {
      await Promise.all([
        mkdir(join(nodeModules, "@openai", "codex-sdk"), { recursive: true }),
        mkdir(join(nodeModules, "ws"), { recursive: true }),
        mkdir(join(bootstrapDir, "node_modules"), { recursive: true }),
      ])
      await writeFile(join(nodeModules, "@openai", "codex-sdk", "package.json"), "{}")
      await writeFile(join(nodeModules, "ws", "package.json"), "{}")

      const harness = createCodexDriver({ sandbox: false }).harness as ReturnType<typeof createCodex>
      const bootstrap = await harness.getBootstrap!()
      const command = bootstrap.commands[1]!.command.replaceAll("/tmp/harness/codex", bootstrapDir)

      await expect(exec("/bin/sh", ["-c", command], {
        env: {
          PATH: process.env.PATH,
          VITEHUB_CODEX_BRIDGE_NODE_MODULES: nodeModules,
        },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("already exists and conflicts with VITEHUB_CODEX_BRIDGE_NODE_MODULES"),
      })
    }
    finally {
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it("maps absolute bootstrap commands and configured dependency paths in the local sandbox", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".codex-local-"))
    const driver = createCodexDriver({
      sandbox: {
        env: {
          PATH: process.env.PATH,
          VITEHUB_CODEX_BRIDGE_NODE_MODULES: "/opt/codex-bridge/node_modules",
        },
        rootDir: root,
      },
    })
    const harness = driver.harness as ReturnType<typeof createCodex>
    const bootstrap = await harness.getBootstrap!()
    const provider = driver.sandbox as HarnessV1SandboxProvider
    let output = ""

    try {
      const session = await provider.createSession({
        onFirstCreate: async (session) => {
          await session.writeTextFile({ content: "ready", path: "/tmp/harness/codex/marker" })
          await session.writeTextFile({ content: "{}", path: "/opt/codex-bridge/node_modules/@openai/codex-sdk/package.json" })
          await session.writeTextFile({ content: "{}", path: "/opt/codex-bridge/node_modules/ws/package.json" })
          const marker = await session.run({ command: "cat /tmp/harness/codex/marker" })
          const dependencies = await session.run({ command: bootstrap.commands[1]!.command })
          const linked = await session.run({ command: "readlink /tmp/harness/codex/node_modules" })
          expect(dependencies).toMatchObject({ exitCode: 0 })
          output = `${marker.stdout}:${linked.stdout}`
        },
      })
      expect(output).toBe(`ready:${join(root, "opt/codex-bridge/node_modules")}\n`)
      await session.destroy?.()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("maps Codex bootstrap text files into the sandbox workspace", async () => {
    const readTextFile = vi.fn(async () => "ready")
    const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "ready" }))
    const writeTextFile = vi.fn(async () => undefined)
    const rawSession = {
      defaultWorkingDirectory: "/workspace",
      env: { VITEHUB_CODEX_BRIDGE_NODE_MODULES: "/opt/codex-bridge/node_modules" },
      readTextFile,
      restricted: () => rawSession,
      run,
      writeTextFile,
    }
    const harness = createCodexDriver({ sandbox: false }).harness as Record<PropertyKey, unknown>
    const adapt = harness[Symbol.for("vitehub.harnessSandboxAdapter")] as (
      provider: HarnessV1SandboxProvider,
    ) => HarnessV1SandboxProvider
    const provider = adapt({
      createSession: async () => rawSession,
      specificationVersion: "harness-sandbox-v1",
    } as unknown as HarnessV1SandboxProvider)
    const session = await provider.createSession()

    await session.writeTextFile({ content: "ready", path: "/tmp/harness/codex/marker" })
    await session.restricted().readTextFile({ path: "/tmp/harness/codex/marker" })
    await session.run({ command: "cat /tmp/harness/codex/marker" })

    expect(writeTextFile).toHaveBeenCalledWith({
      content: "ready",
      path: "/workspace/tmp/harness/codex/marker",
    })
    expect(readTextFile).toHaveBeenCalledWith({
      path: "/workspace/tmp/harness/codex/marker",
    })
    expect(run).toHaveBeenCalledWith({
      command: "cat /workspace/tmp/harness/codex/marker",
      env: { CODEX_HOME: "/workspace/tmp/harness/codex-home" },
    })
    expect(rawSession.env.VITEHUB_CODEX_BRIDGE_NODE_MODULES).toBe("/opt/codex-bridge/node_modules")
  })

  it("adapts a Box sandbox for Codex paths and direct OpenAI auth", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".codex-box-"))
    const harness = createCodexDriver({ sandbox: false }).harness as Record<PropertyKey, unknown>
    const adapt = harness[Symbol.for("vitehub.harnessSandboxAdapter")] as (provider: HarnessV1SandboxProvider) => HarnessV1SandboxProvider
    const provider = adapt(createLocalHarnessSandbox({
      env: {
        AI_GATEWAY_API_KEY: "host-key",
        AI_GATEWAY_BASE_URL: "https://gateway.example",
        PATH: process.env.PATH,
      },
      rootDir: root,
    }))

    try {
      const session = await provider.createSession()
      await session.writeTextFile({ content: "ready", path: "/tmp/harness/codex/marker" })

      expect((session as unknown as { env: Record<string, string> }).env.AI_GATEWAY_API_KEY).toBeUndefined()
      expect((session as unknown as { env: Record<string, string> }).env.AI_GATEWAY_BASE_URL).toBeUndefined()
      await expect(session.run({ command: "cat /tmp/harness/codex/marker" })).resolves.toMatchObject({ stdout: "ready" })
      await session.destroy?.()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
